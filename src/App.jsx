import React, { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import "./App.css";
import { Amplify } from "aws-amplify";
import { Authenticator } from "@aws-amplify/ui-react";
import { fetchAuthSession, updatePassword } from "aws-amplify/auth";
import "@aws-amplify/ui-react/styles.css";

const COGNITO_USER_POOL_ID = "us-east-2_ilzCxx6S5";
const COGNITO_USER_POOL_CLIENT_ID = "3kn1m7tu6sav8ufplc4jvk2h3v";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: COGNITO_USER_POOL_ID,
      userPoolClientId: COGNITO_USER_POOL_CLIENT_ID,
    },
  },
});

const DEFAULT_API_BASE_URL = "https://qzd88m0dib.execute-api.us-east-2.amazonaws.com";
const DEFAULT_WEBSOCKET_URL =
  "wss://muieahppa0.execute-api.us-east-2.amazonaws.com/production";
const DEFAULT_RESULTS_BUCKET = "amazon-sagemaker-888689904936-us-east-2-c4s3kaz6i9iu5l";
const DEFAULT_RESULTS_PREFIX = "shared/code/results";
const POLL_INTERVAL_MS = 15000;
const STOPPING_POLL_INTERVAL_MS = 5000;
const ADMIN_GROUP_NAME = "Admins";
const THEME_STORAGE_KEY = "neuron-segmentation-theme";
const WEBSOCKET_RECONNECT_BASE_MS = 1000;
const WEBSOCKET_RECONNECT_MAX_MS = 30000;
const WEBSOCKET_REFRESH_DELAY_MS = 750;

const RESULT_MODE_ZIP_ONLY = "zip-only";
const RESULT_MODE_ZIP_AND_PNG = "zip-and-png";

const CANCELABLE_JOB_STATUSES = ["QUEUED", "STARTING", "RUNNING", "InProgress"];
const STOPPING_JOB_STATUSES = ["STOPPING", "Stopping"];
const CANCELED_JOB_STATUSES = ["CANCELED", "Canceled", "STOPPED", "Stopped"];
const COMPLETED_JOB_STATUSES = ["COMPLETED", "Completed"];
const FAILED_JOB_STATUSES = [
  "FAILED",
  "Failed",
  "FAILED_TO_START",
  "FAILED_TO_QUEUE",
];

function getNextPollInterval(status) {
  if (STOPPING_JOB_STATUSES.includes(status)) {
    return STOPPING_POLL_INTERVAL_MS;
  }

  return POLL_INTERVAL_MS;
}

function getInitialTheme() {
  if (typeof window === "undefined") {
    return "light";
  }

  const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);

  if (savedTheme === "light" || savedTheme === "dark") {
    return savedTheme;
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function ThemeToggle({ theme, onToggle }) {
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="theme-toggle-button"
      onClick={onToggle}
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
    >
      <span aria-hidden="true">{isDark ? "☀" : "☾"}</span>
      <span>{isDark ? "Light mode" : "Dark mode"}</span>
    </button>
  );
}

function getApiBaseUrl() {
  const envUrl = import.meta.env.VITE_API_BASE_URL;
  return (envUrl || DEFAULT_API_BASE_URL).replace(/\/$/, "");
}

function getWebSocketUrl() {
  const envUrl = import.meta.env.VITE_WEBSOCKET_URL;
  return (envUrl || DEFAULT_WEBSOCKET_URL).replace(/\/$/, "");
}

function getWebSocketStatusLabel(status) {
  switch (status) {
    case "connected":
      return "Live updates connected";
    case "connecting":
      return "Connecting live updates...";
    case "reconnecting":
      return "Reconnecting live updates...";
    case "error":
      return "Live updates unavailable";
    default:
      return "Live updates inactive";
  }
}

function getGroupsFromPayload(payload) {
  const groups = payload?.["cognito:groups"] || [];

  if (Array.isArray(groups)) {
    return groups;
  }

  if (typeof groups === "string") {
    return groups
      .replace("[", "")
      .replace("]", "")
      .replaceAll("\"", "")
      .replaceAll("'", "")
      .replaceAll(",", " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  return [];
}

function guessContentType(file) {
  if (file?.type) return file.type;

  const name = file?.name?.toLowerCase() || "";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".tif") || name.endsWith(".tiff")) return "image/tiff";
  return "application/octet-stream";
}

function isAcceptedInputFile(file) {
  const name = file?.name?.toLowerCase() || "";

  return (
    name.endsWith(".zip") ||
    name.endsWith(".tif") ||
    name.endsWith(".tiff")
  );
}

function isZipResult(item) {
  return (item?.key || "").toLowerCase().endsWith(".zip");
}

function isPngResult(item) {
  return (item?.key || "").toLowerCase().endsWith(".png");
}

function filterResults(files, resultMode) {
  if (resultMode === RESULT_MODE_ZIP_AND_PNG) {
    return files.filter((item) => isZipResult(item) || isPngResult(item));
  }

  return files.filter((item) => isZipResult(item));
}

function getResultDisplayName(key) {
  const parts = (key || "").split("/").filter(Boolean);
  const fileName = parts[parts.length - 1] || key;
  const parentFolder = parts[parts.length - 2];

  // Many ImageJ/ROI outputs are named RoiSet.zip. Add the parent folder so
  // multiple stack outputs are easy to tell apart in the result list.
  if (fileName === "RoiSet.zip" && parentFolder) {
    return `${parentFolder} - ${fileName}`;
  }

  return fileName;
}

async function prepareUploadFile(files, model) {
  if (!files || files.length === 0) {
    throw new Error("Please choose at least one input file.");
  }

  if (files.length === 1) {
    return files[0];
  }

  const zip = new JSZip();
  files.forEach((file) => {
    zip.file(file.name, file);
  });

  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], `${model}-input-${Date.now()}.zip`, {
    type: "application/zip",
  });
}

function getFileKey(file) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function mergeSelectedFiles(previousFiles, newlySelectedFiles) {
  const fileMap = new Map();

  previousFiles.forEach((file) => {
    fileMap.set(getFileKey(file), file);
  });

  newlySelectedFiles.forEach((file) => {
    fileMap.set(getFileKey(file), file);
  });

  return Array.from(fileMap.values());
}

function makeOutputS3(model) {
  const timestamp = Date.now();
  return `s3://${DEFAULT_RESULTS_BUCKET}/${DEFAULT_RESULTS_PREFIX}/web-${model}-${timestamp}/`;
}

function formatDate(value) {
  if (!value) return "-";

  let normalizedValue = value;
  const numericValue = Number(value);

  if (Number.isFinite(numericValue)) {
    normalizedValue = numericValue < 1_000_000_000_000
      ? numericValue * 1000
      : numericValue;
  }

  const date = new Date(normalizedValue);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function getBooleanDisplay(value) {
  if (value === true || value === "true") return "Yes";
  if (value === false || value === "false") return "No";
  return "-";
}

function downloadCredentialFile(credentials) {
  const lines = [
    "Neuron Segmentation Website Login",
    "",
    `Username: ${credentials.username}`,
  ];

  if (
    credentials.email &&
    credentials.email.trim().toLowerCase() !==
      credentials.username.trim().toLowerCase()
  ) {
    lines.push(`Email: ${credentials.email}`);
  }

  lines.push(
    `Password: ${credentials.password}`,
    "",
    `Generated: ${credentials.generatedAt}`
  );

  const blob = new Blob([lines.join("\n")], {
    type: "text/plain;charset=utf-8",
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName = (credentials.username || credentials.email || "user").replace(
    /[^a-z0-9@._-]/gi,
    "_"
  );

  link.href = url;
  link.download = `${safeName}-login.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function readJsonResponse(response, fallbackMessage) {
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const message =
      data.error ||
      data.message ||
      fallbackMessage ||
      `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function getAuthorizationHeaders(options = {}) {
  const session = await fetchAuthSession(options);
  const idToken = session.tokens?.idToken?.toString();

  if (!idToken) {
    throw new Error("You are not signed in. Please sign in again.");
  }

  return {
    Authorization: `Bearer ${idToken}`,
  };
}

async function apiPost(path, body, options = {}) {
  const authHeaders = await getAuthorizationHeaders(options);

  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: JSON.stringify(body),
  });

  return readJsonResponse(response, `POST ${path} failed`);
}

async function createUploadUrl(file) {
  return apiPost("/create-upload-url", {
    filename: file.name,
    content_type: guessContentType(file),
  });
}

async function uploadFileToS3(uploadUrl, file) {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": guessContentType(file),
    },
    body: file,
  });

  if (!response.ok) {
    throw new Error(`S3 upload failed with status ${response.status}`);
  }
}

async function startJob(model, inputS3) {
  const outputS3 = makeOutputS3(model);
  const jobName = `web-${model}-${Date.now()}`;

  return apiPost("/start-job", {
    model,
    input_s3: inputS3,
    output_s3: outputS3,
    job_name: jobName,
  });
}

async function checkJobStatus(jobId) {
  return apiPost("/job-status", {
    job_id: jobId,
  });
}

async function stopJob(jobId) {
  return apiPost("/stop-job", {
    job_id: jobId,
  });
}

async function listResults(outputS3) {
  return apiPost("/list-results", {
    output_s3: outputS3,
  });
}

async function getMyJobs() {
  return apiPost("/my-jobs", {});
}

function isActiveJob(job) {
  if (typeof job?.is_active === "boolean") {
    return job.is_active;
  }

  return [
    ...CANCELABLE_JOB_STATUSES,
    ...STOPPING_JOB_STATUSES,
  ].includes(job?.dynamodb_status || job?.status);
}

function isCompletedJob(job) {
  return COMPLETED_JOB_STATUSES.includes(
    job?.dynamodb_status || job?.status
  );
}

function getJobStatusClass(job) {
  const status = job?.dynamodb_status || job?.status || "";

  if (isCompletedJob(job)) return "completed";
  if (FAILED_JOB_STATUSES.includes(status)) return "failed";
  if (CANCELED_JOB_STATUSES.includes(status)) return "canceled";
  if (STOPPING_JOB_STATUSES.includes(status)) return "stopping";
  if (isActiveJob(job)) return "active";

  return "neutral";
}

function PasswordInput({
  id,
  label,
  value,
  onChange,
  showPassword,
  onToggleShow,
  placeholder = "Password",
  autoComplete = "new-password",
}) {
  return (
    <div className="password-field">
      {label && <label htmlFor={id}>{label}</label>}
      <div className="password-input-row">
        <input
          id={id}
          type={showPassword ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
        />
        <button
          type="button"
          className="password-eye-button"
          onClick={onToggleShow}
        >
          {showPassword ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

function AdminPanel({ signedInAs }) {
  const normalizedSignedInAs = (signedInAs || "").trim().toLowerCase();

  const isSignedInAdminUser = (adminUser) => {
    const username = (adminUser?.username || "").trim().toLowerCase();
    const email = (adminUser?.email || "").trim().toLowerCase();

    if (!normalizedSignedInAs) {
      return false;
    }

    return username === normalizedSignedInAs || email === normalizedSignedInAs;
  };

  const [users, setUsers] = useState([]);
  const [enabledUserCount, setEnabledUserCount] = useState(0);
  const [totalUserCount, setTotalUserCount] = useState(0);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminMessage, setAdminMessage] = useState("");
  const [busyAction, setBusyAction] = useState("");

  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [showNewUserPassword, setShowNewUserPassword] = useState(false);
  const [createdUserCredentials, setCreatedUserCredentials] = useState(null);

  const [passwordDrafts, setPasswordDrafts] = useState({});
  const [visiblePasswordDrafts, setVisiblePasswordDrafts] = useState({});
  const [deleteConfirmUsername, setDeleteConfirmUsername] = useState("");
  const [rowFeedback, setRowFeedback] = useState({});
  const [credentialDownloads, setCredentialDownloads] = useState({});

  const [currentPassword, setCurrentPassword] = useState("");
  const [newOwnPassword, setNewOwnPassword] = useState("");
  const [confirmOwnPassword, setConfirmOwnPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showOwnNewPassword, setShowOwnNewPassword] = useState(false);
  const [showOwnConfirmPassword, setShowOwnConfirmPassword] = useState(false);

  const runAdminAction = async (action, payload = {}) => {
    return apiPost("/admin-users", { action, ...payload }, { forceRefresh: true });
  };

  const setUserFeedback = (username, type, message) => {
    setRowFeedback((previous) => ({
      ...previous,
      [username]: { type, message },
    }));
  };

  const clearUserFeedback = (username) => {
    setRowFeedback((previous) => {
      const next = { ...previous };
      delete next[username];
      return next;
    });
  };

  const loadUsers = async () => {
    setIsLoadingUsers(true);
    setAdminError("");

    try {
      const response = await runAdminAction("list_users");
      const nextUsers = response.users || [];
      const nextTotalUserCount = response.count ?? nextUsers.length;
      const nextEnabledUserCount = nextUsers.filter(
        (adminUser) => adminUser.enabled
      ).length;

      setUsers(nextUsers);
      setEnabledUserCount(nextEnabledUserCount);
      setTotalUserCount(nextTotalUserCount);
    } catch (error) {
      setAdminError(error.message);
    } finally {
      setIsLoadingUsers(false);
    }
  };

  useEffect(() => {
    loadUsers();
    // This should run once when the admin panel appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshAfterAction = async (successMessage) => {
    setAdminMessage(successMessage);
    await loadUsers();
  };

  const handleCreateUser = async (event) => {
    event.preventDefault();
    setAdminError("");
    setAdminMessage("");

    const email = newUserEmail.trim();
    const password = newUserPassword;

    if (!email || !password) {
      setAdminError("Enter an email and password for the new user.");
      return;
    }

    setCreatedUserCredentials(null);
    setBusyAction("create_user");

    try {
      const response = await runAdminAction("create_user", {
        email,
        password,
      });

      const username =
        response.username ||
        response.user?.username ||
        response.user?.Username ||
        email;

      const credentials = {
        username,
        email,
        password,
        generatedAt: new Date().toLocaleString(),
      };

      setCreatedUserCredentials(credentials);
      downloadCredentialFile(credentials);

      setNewUserEmail("");
      setNewUserPassword("");
      setShowNewUserPassword(false);

      await refreshAfterAction(
        `Created ${username}. The login TXT file was downloaded.`
      );
    } catch (error) {
      setAdminError(error.message);
    } finally {
      setBusyAction("");
    }
  };

  const downloadCredentialsTxt = (username) => {
    const credentials = credentialDownloads[username];

    if (!credentials) {
      setUserFeedback(
        username,
        "error",
        "No newly-set password is available to download."
      );
      return;
    }

    downloadCredentialFile(credentials);

    setCredentialDownloads((previous) => {
      const next = { ...previous };
      delete next[username];
      return next;
    });

    setUserFeedback(
      username,
      "success",
      "Credentials downloaded. The password copy was cleared from this page."
    );
  };

  const handleSetUserPassword = async (username) => {
    const password = passwordDrafts[username] || "";
    const targetUser = users.find((existingUser) => existingUser.username === username);

    setAdminError("");
    setAdminMessage("");
    clearUserFeedback(username);

    if (targetUser && isSignedInAdminUser(targetUser)) {
      setUserFeedback(
        username,
        "warning",
        "Use the Change my password section for your own admin account."
      );
      return;
    }

    if (!password) {
      setUserFeedback(username, "error", "Enter a new password for this user first.");
      return;
    }

    setBusyAction(`set_password:${username}`);
    try {
      await runAdminAction("set_password", {
        username,
        password,
      });

      const targetEmail = targetUser?.email || "";

      setCredentialDownloads((previous) => ({
        ...previous,
        [username]: {
          username,
          email: targetEmail,
          password,
          generatedAt: new Date().toLocaleString(),
        },
      }));

      setPasswordDrafts((previous) => ({ ...previous, [username]: "" }));
      setVisiblePasswordDrafts((previous) => ({ ...previous, [username]: false }));
      setUserFeedback(
        username,
        "success",
        "Password updated. You can now download the temporary credential TXT file."
      );
    } catch (error) {
      setUserFeedback(username, "error", error.message || "Password update failed.");
    } finally {
      setBusyAction("");
    }
  };

  const handleToggleEnabled = async (user) => {
    const action = user.enabled ? "disable_user" : "enable_user";
    const actionLabel = user.enabled ? "disabled" : "enabled";
    setAdminError("");
    setAdminMessage("");
    clearUserFeedback(user.username);

    if (isSignedInAdminUser(user)) {
      setUserFeedback(
        user.username,
        "warning",
        "You cannot disable your own admin account from this list."
      );
      return;
    }

    setBusyAction(`${action}:${user.username}`);

    try {
      await runAdminAction(action, {
        username: user.username,
      });
      setUserFeedback(user.username, "success", `User ${actionLabel}.`);
      await loadUsers();
    } catch (error) {
      setUserFeedback(user.username, "error", error.message || `Could not ${actionLabel} user.`);
    } finally {
      setBusyAction("");
    }
  };

  const handleDeleteUser = async (username) => {
    const targetUser = users.find((existingUser) => existingUser.username === username);

    setAdminError("");
    setAdminMessage("");
    clearUserFeedback(username);

    if (targetUser && isSignedInAdminUser(targetUser)) {
      setUserFeedback(
        username,
        "warning",
        "You cannot delete your own admin account from this list."
      );
      return;
    }

    if (deleteConfirmUsername !== username) {
      setDeleteConfirmUsername(username);
      setUserFeedback(username, "warning", "Click Confirm delete to permanently remove this user.");
      return;
    }

    setBusyAction(`delete_user:${username}`);
    try {
      await runAdminAction("delete_user", {
        username,
      });
      setDeleteConfirmUsername("");
      await refreshAfterAction(`${username} deleted.`);
    } catch (error) {
      setUserFeedback(username, "error", error.message || "Delete failed.");
    } finally {
      setBusyAction("");
    }
  };

  const handleOwnPasswordChange = async (event) => {
    event.preventDefault();
    setAdminError("");
    setAdminMessage("");

    if (!currentPassword || !newOwnPassword) {
      setAdminError("Enter your current password and new password.");
      return;
    }

    if (newOwnPassword !== confirmOwnPassword) {
      setAdminError("New password and confirmation do not match.");
      return;
    }

    setBusyAction("change_own_password");
    try {
      await updatePassword({
        oldPassword: currentPassword,
        newPassword: newOwnPassword,
      });
      setCurrentPassword("");
      setNewOwnPassword("");
      setConfirmOwnPassword("");
      setShowCurrentPassword(false);
      setShowOwnNewPassword(false);
      setShowOwnConfirmPassword(false);
      setAdminMessage("Your password was changed.");
    } catch (error) {
      setAdminError(error.message || "Failed to change password.");
    } finally {
      setBusyAction("");
    }
  };

  return (
    <section className="card admin-card">
      <div className="admin-card-header">
        <div>
          <h2>Admin Panel</h2>
          <p className="subtitle admin-subtitle">
            Manage website users, access, and passwords. Existing passwords are
            never shown; you can only set a new one.
          </p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={loadUsers}
          disabled={isLoadingUsers}
        >
          {isLoadingUsers ? "Refreshing..." : "Refresh users"}
        </button>
      </div>

      <div className="admin-stats-grid">
        <div className="admin-stat-box">
          <span>Enabled users with access</span>
          <strong>{enabledUserCount}</strong>
        </div>
        <div className="admin-stat-box">
          <span>Total users</span>
          <strong>{totalUserCount}</strong>
        </div>
        <div className="admin-stat-box">
          <span>Signed-in admin</span>
          <strong>{signedInAs}</strong>
        </div>
      </div>

      {adminMessage && <div className="success-box">{adminMessage}</div>}
      {adminError && <div className="error-box">{adminError}</div>}

      <details className="admin-section" open>
        <summary>Create user</summary>
        <form className="admin-form" onSubmit={handleCreateUser}>
          <div className="field">
            <label htmlFor="new-user-email">New user email</label>
            <input
              id="new-user-email"
              type="email"
              value={newUserEmail}
              onChange={(event) => setNewUserEmail(event.target.value)}
              placeholder="newuser@example.com"
              autoComplete="off"
            />
          </div>

          <PasswordInput
            id="new-user-password"
            label="New user password"
            value={newUserPassword}
            onChange={setNewUserPassword}
            showPassword={showNewUserPassword}
            onToggleShow={() => setShowNewUserPassword((previous) => !previous)}
            placeholder="Temporary or permanent password"
          />

          <button
            type="submit"
            className="admin-action-button"
            disabled={busyAction === "create_user"}
          >
            {busyAction === "create_user" ? "Creating..." : "Create user"}
          </button>

          {createdUserCredentials && (
            <div className="created-credentials-box">
              <p>
                Login credentials were generated for{" "}
                <strong>{createdUserCredentials.username}</strong>. The TXT
                download should start automatically.
              </p>
              <div className="admin-row-actions">
                <button
                  type="button"
                  className="small-button"
                  onClick={() =>
                    downloadCredentialFile(createdUserCredentials)
                  }
                >
                  Download TXT again
                </button>
                <button
                  type="button"
                  className="small-danger-button"
                  onClick={() => setCreatedUserCredentials(null)}
                >
                  Clear credentials from page
                </button>
              </div>
            </div>
          )}
        </form>
      </details>

      <details className="admin-section">
        <summary>Change my password</summary>
        <form className="admin-form" onSubmit={handleOwnPasswordChange}>
          <PasswordInput
            id="current-admin-password"
            label="Current password"
            value={currentPassword}
            onChange={setCurrentPassword}
            showPassword={showCurrentPassword}
            onToggleShow={() => setShowCurrentPassword((previous) => !previous)}
            placeholder="Current password"
            autoComplete="current-password"
          />
          <PasswordInput
            id="new-admin-password"
            label="New password"
            value={newOwnPassword}
            onChange={setNewOwnPassword}
            showPassword={showOwnNewPassword}
            onToggleShow={() => setShowOwnNewPassword((previous) => !previous)}
            placeholder="New password"
          />
          <PasswordInput
            id="confirm-admin-password"
            label="Confirm new password"
            value={confirmOwnPassword}
            onChange={setConfirmOwnPassword}
            showPassword={showOwnConfirmPassword}
            onToggleShow={() => setShowOwnConfirmPassword((previous) => !previous)}
            placeholder="Confirm new password"
          />

          <button
            type="submit"
            className="admin-action-button"
            disabled={busyAction === "change_own_password"}
          >
            {busyAction === "change_own_password"
              ? "Changing..."
              : "Change my password"}
          </button>
        </form>
      </details>

      <div className="admin-users-header">
        <h3>Users</h3>
        <p className="field-help">
          Use “Set password” to replace a password. The current password cannot
          be viewed.
        </p>
      </div>

      {isLoadingUsers ? (
        <div className="status-box">Loading users...</div>
      ) : users.length === 0 ? (
        <div className="status-box">No users found.</div>
      ) : (
        <div className="admin-user-list">
          {users.map((adminUser) => {
            const username = adminUser.username;
            const passwordDraft = passwordDrafts[username] || "";
            const showDraft = Boolean(visiblePasswordDrafts[username]);
            const isRowBusy = busyAction.endsWith(`:${username}`);
            const feedback = rowFeedback[username];
            const isCurrentAdminUser = isSignedInAdminUser(adminUser);

            return (
              <article className="admin-user-card" key={username}>
                <div className="admin-user-main">
                  <div>
                    <h4>{adminUser.email || username}</h4>
                    <p className="admin-username-line">Username: {username}</p>
                  </div>
                  <span
                    className={
                      adminUser.enabled
                        ? "admin-status-pill enabled"
                        : "admin-status-pill disabled"
                    }
                  >
                    {adminUser.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>

                <div className="admin-user-meta-grid">
                  <div>
                    <span>Status</span>
                    <strong>{adminUser.status || "-"}</strong>
                  </div>
                  <div>
                    <span>Email verified</span>
                    <strong>{getBooleanDisplay(adminUser.email_verified)}</strong>
                  </div>
                  <div>
                    <span>Created</span>
                    <strong>{formatDate(adminUser.created_at)}</strong>
                  </div>
                </div>

                {feedback && (
                  <div className={`row-feedback ${feedback.type}`}>
                    {feedback.message}
                  </div>
                )}

                {isCurrentAdminUser ? (
                  <div className="admin-self-protection-box">
                    <strong>Your current admin account</strong>
                    
                  </div>
                ) : (
                  <div className="admin-user-actions-grid">
                    <div>
                      <p className="admin-action-label">Access</p>
                      <div className="admin-row-actions">
                        <button
                          type="button"
                          className="small-button"
                          onClick={() => handleToggleEnabled(adminUser)}
                          disabled={isRowBusy}
                        >
                          {adminUser.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          type="button"
                          className="small-danger-button"
                          onClick={() => handleDeleteUser(username)}
                          disabled={isRowBusy}
                        >
                          {deleteConfirmUsername === username
                            ? "Confirm delete"
                            : "Delete"}
                        </button>
                      </div>
                    </div>

                    <div>
                      <p className="admin-action-label">Set new password</p>
                      <div className="admin-password-reset-row">
                        <input
                          type={showDraft ? "text" : "password"}
                          value={passwordDraft}
                          onChange={(event) => {
                            clearUserFeedback(username);
                            setCredentialDownloads((previous) => {
                              const next = { ...previous };
                              delete next[username];
                              return next;
                            });
                            setPasswordDrafts((previous) => ({
                              ...previous,
                              [username]: event.target.value,
                            }));
                          }}
                          placeholder="New password"
                          autoComplete="new-password"
                        />
                        <button
                          type="button"
                          className="small-button"
                          onClick={() =>
                            setVisiblePasswordDrafts((previous) => ({
                              ...previous,
                              [username]: !previous[username],
                            }))
                          }
                        >
                          {showDraft ? "Hide" : "Show"}
                        </button>
                        <button
                          type="button"
                          className="admin-action-button compact"
                          onClick={() => handleSetUserPassword(username)}
                          disabled={isRowBusy}
                        >
                          {busyAction === `set_password:${username}`
                            ? "Setting..."
                            : "Set password"}
                        </button>
                        {credentialDownloads[username] && (
                          <button
                            type="button"
                            className="small-button"
                            onClick={() => downloadCredentialsTxt(username)}
                          >
                            Download TXT
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SegmentationApp({ signOut, user }) {
  const [model, setModel] = useState("anmaf");
  const [resultMode, setResultMode] = useState(RESULT_MODE_ZIP_ONLY);
  const [files, setFiles] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [step, setStep] = useState("Choose a model and upload a file.");
  const [error, setError] = useState("");
  const [uploadInfo, setUploadInfo] = useState(null);
  const [jobInfo, setJobInfo] = useState(null);

  const [myJobs, setMyJobs] = useState([]);
  const [isLoadingMyJobs, setIsLoadingMyJobs] = useState(false);
  const [myJobsError, setMyJobsError] = useState("");
  const [myJobsMessage, setMyJobsMessage] = useState("");
  const [myJobsUpdatedAt, setMyJobsUpdatedAt] = useState(null);
  const [myJobsPollGeneration, setMyJobsPollGeneration] = useState(0);

  const [jobResults, setJobResults] = useState({});
  const [jobResultErrors, setJobResultErrors] = useState({});
  const [loadingJobResults, setLoadingJobResults] = useState({});
  const [downloadingJobResults, setDownloadingJobResults] = useState({});
  const [jobDownloadErrors, setJobDownloadErrors] = useState({});
  const [cancelingJobIds, setCancelingJobIds] = useState({});
  const [jobToCancel, setJobToCancel] = useState(null);

  const [isAdmin, setIsAdmin] = useState(false);
  const [isCheckingAdmin, setIsCheckingAdmin] = useState(true);
  const [webSocketStatus, setWebSocketStatus] = useState("connecting");
  const [webSocketError, setWebSocketError] = useState("");

  const fileInputRef = useRef(null);
  const dragCounterRef = useRef(0);
  const myJobsPollTimeoutRef = useRef(null);
  const jobResultsRef = useRef({});
  const loadingResultsRef = useRef(new Set());
  const loadMyJobsRef = useRef(null);
  const webSocketRef = useRef(null);
  const webSocketInitialConnectTimeoutRef = useRef(null);
  const webSocketReconnectTimeoutRef = useRef(null);
  const webSocketRefreshTimeoutRef = useRef(null);
  const webSocketReconnectAttemptRef = useRef(0);

  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const webSocketUrl = useMemo(() => getWebSocketUrl(), []);
  const isAdminView = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("view") === "admin" || window.location.hash === "#admin";
  }, []);
  const adminPanelUrl = useMemo(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "admin");
    url.hash = "";
    return url.toString();
  }, []);
  const signedInAs =
    user?.signInDetails?.loginId ||
    user?.attributes?.email ||
    user?.username ||
    "Signed in";

  useEffect(() => {
    jobResultsRef.current = jobResults;
  }, [jobResults]);

  // Submission confirmations are temporary. Live job status is displayed in
  // the My Jobs cards and refreshed by /my-jobs.
  useEffect(() => {
    if (!myJobsMessage) {
      return undefined;
    }

    const messageTimeout = window.setTimeout(() => {
      setMyJobsMessage("");
    }, 5000);

    return () => window.clearTimeout(messageTimeout);
  }, [myJobsMessage]);

  useEffect(() => {
    let isMounted = true;

    async function checkAdminStatus() {
      setIsCheckingAdmin(true);

      try {
        const session = await fetchAuthSession({ forceRefresh: true });
        const groups = getGroupsFromPayload(session.tokens?.idToken?.payload);

        if (isMounted) {
          setIsAdmin(groups.includes(ADMIN_GROUP_NAME));
        }
      } catch {
        if (isMounted) {
          setIsAdmin(false);
        }
      } finally {
        if (isMounted) {
          setIsCheckingAdmin(false);
        }
      }
    }

    checkAdminStatus();

    return () => {
      isMounted = false;
    };
  }, [signedInAs]);

  const loadResultsForJob = async (job, options = {}) => {
    const { force = false } = options;
    const jobId = job?.job_id;

    if (!jobId || !job?.output_s3 || !isCompletedJob(job)) {
      return;
    }

    if (!force && Object.prototype.hasOwnProperty.call(
      jobResultsRef.current,
      jobId
    )) {
      return;
    }

    if (loadingResultsRef.current.has(jobId)) {
      return;
    }

    loadingResultsRef.current.add(jobId);
    setLoadingJobResults((previous) => ({
      ...previous,
      [jobId]: true,
    }));
    setJobResultErrors((previous) => {
      const next = { ...previous };
      delete next[jobId];
      return next;
    });

    try {
      const response = await listResults(job.output_s3);
      const filesForJob = response.files || [];

      jobResultsRef.current = {
        ...jobResultsRef.current,
        [jobId]: filesForJob,
      };

      setJobResults((previous) => ({
        ...previous,
        [jobId]: filesForJob,
      }));
    } catch (resultError) {
      setJobResultErrors((previous) => ({
        ...previous,
        [jobId]:
          resultError.message ||
          "The result files could not be loaded.",
      }));
    } finally {
      loadingResultsRef.current.delete(jobId);
      setLoadingJobResults((previous) => ({
        ...previous,
        [jobId]: false,
      }));
    }
  };

  const downloadAllResultsForJob = async (job, resultFiles) => {
    const jobId = job?.job_id;

    if (!jobId || !Array.isArray(resultFiles) || resultFiles.length === 0) {
      return;
    }

    setDownloadingJobResults((previous) => ({
      ...previous,
      [jobId]: true,
    }));

    setJobDownloadErrors((previous) => {
      const next = { ...previous };
      delete next[jobId];
      return next;
    });

    try {
      const combinedZip = new JSZip();
      const usedNames = new Set();

      for (let index = 0; index < resultFiles.length; index += 1) {
        const item = resultFiles[index];
        const downloadUrl = item?.download_url;

        if (!downloadUrl) {
          throw new Error(
            `A download link is missing for ${getResultDisplayName(item?.key)}.`
          );
        }

        const response = await fetch(downloadUrl);

        if (!response.ok) {
          throw new Error(
            `Could not download ${getResultDisplayName(item?.key)} ` +
              `(${response.status}). Refresh the results and try again.`
          );
        }

        const fileBlob = await response.blob();
        const fallbackName = `result-${index + 1}`;
        const originalName = getResultDisplayName(item?.key) || fallbackName;
        const safeName = originalName.replace(/[<>:"/\\|?*]/g, "_");

        let uniqueName = safeName;
        let duplicateNumber = 2;

        while (usedNames.has(uniqueName)) {
          const dotIndex = safeName.lastIndexOf(".");

          uniqueName = dotIndex > 0
            ? `${safeName.slice(0, dotIndex)} (${duplicateNumber})${safeName.slice(dotIndex)}`
            : `${safeName} (${duplicateNumber})`;

          duplicateNumber += 1;
        }

        usedNames.add(uniqueName);
        combinedZip.file(uniqueName, fileBlob);
      }

      const zipBlob = await combinedZip.generateAsync({ type: "blob" });
      const objectUrl = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");
      const modelName = String(job.model || "segmentation")
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-");

      link.href = objectUrl;
      link.download = `${modelName}-${jobId}-results.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();

      window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
      }, 1000);
    } catch (downloadError) {
      console.error("Download all results failed:", downloadError);

      setJobDownloadErrors((previous) => ({
        ...previous,
        [jobId]:
          downloadError.message ||
          "The result files could not be downloaded.",
      }));
    } finally {
      setDownloadingJobResults((previous) => ({
        ...previous,
        [jobId]: false,
      }));
    }
  };

  const loadMyJobs = async (options = {}) => {
    const {
      showLoading = false,
      autoLoadCompletedResults = true,
    } = options;

    if (showLoading) {
      setIsLoadingMyJobs(true);
    }

    setMyJobsError("");

    try {
      const response = await getMyJobs();
      const nextJobs = response.jobs || [];

      setMyJobs(nextJobs);
      setMyJobsUpdatedAt(new Date());

      if (autoLoadCompletedResults) {
        nextJobs
          .filter((job) => isCompletedJob(job) && job.output_s3)
          .forEach((job) => {
            void loadResultsForJob(job);
          });
      }

      return response;
    } catch (jobsError) {
      setMyJobsError(
        jobsError.message || "Your jobs could not be loaded."
      );
      return null;
    } finally {
      if (showLoading) {
        setIsLoadingMyJobs(false);
      }
    }
  };

  useEffect(() => {
    loadMyJobsRef.current = loadMyJobs;
  });

  useEffect(() => {
    if (isAdminView) {
      return undefined;
    }

    let disposed = false;

    const refreshAndSchedule = async (showLoading = false) => {
      const response = await loadMyJobs({ showLoading });

      if (
        !disposed &&
        response?.has_active_jobs
      ) {
        myJobsPollTimeoutRef.current = setTimeout(
          () => refreshAndSchedule(false),
          POLL_INTERVAL_MS
        );
      }
    };

    refreshAndSchedule(true);

    return () => {
      disposed = true;

      if (myJobsPollTimeoutRef.current) {
        clearTimeout(myJobsPollTimeoutRef.current);
        myJobsPollTimeoutRef.current = null;
      }
    };

    // Polling is deliberately restarted after a new job or cancellation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedInAs, isAdminView, myJobsPollGeneration]);

  useEffect(() => {
    if (isAdminView || !webSocketUrl) {
      setWebSocketStatus("inactive");
      return undefined;
    }

    let disposed = false;

    const clearReconnectTimer = () => {
      if (webSocketReconnectTimeoutRef.current) {
        window.clearTimeout(webSocketReconnectTimeoutRef.current);
        webSocketReconnectTimeoutRef.current = null;
      }
    };

    const clearRefreshTimer = () => {
      if (webSocketRefreshTimeoutRef.current) {
        window.clearTimeout(webSocketRefreshTimeoutRef.current);
        webSocketRefreshTimeoutRef.current = null;
      }
    };

    const refreshJobsSoon = (delay = WEBSOCKET_REFRESH_DELAY_MS) => {
      clearRefreshTimer();

      webSocketRefreshTimeoutRef.current = window.setTimeout(() => {
        if (!disposed) {
          void loadMyJobsRef.current?.({
            autoLoadCompletedResults: true,
          });
        }
      }, delay);
    };

    const applyLiveJobUpdate = (message) => {
      const nextStatus = message.status || message.sagemaker_status;

      setMyJobs((previousJobs) =>
        previousJobs.map((job) => {
          if (job.job_id !== message.job_id) {
            return job;
          }

          return {
            ...job,
            status: nextStatus || job.status,
            dynamodb_status: nextStatus || job.dynamodb_status,
            started_at: message.started_at ?? job.started_at,
            finished_at: message.finished_at ?? job.finished_at,
            failure_reason:
              message.failure_reason === undefined
                ? job.failure_reason
                : message.failure_reason,
            output_s3: message.output_s3 || job.output_s3,
            is_active: [
              ...CANCELABLE_JOB_STATUSES,
              ...STOPPING_JOB_STATUSES,
            ].includes(nextStatus),
          };
        })
      );

      setMyJobsUpdatedAt(new Date());

      if (COMPLETED_JOB_STATUSES.includes(nextStatus)) {
        setMyJobsMessage(
          `${(message.model || "Job").toUpperCase()} completed. Loading results...`
        );
      } else if (FAILED_JOB_STATUSES.includes(nextStatus)) {
        setMyJobsMessage(
          `${(message.model || "Job").toUpperCase()} finished with an error.`
        );
      } else if (CANCELED_JOB_STATUSES.includes(nextStatus)) {
        setMyJobsMessage(
          `${(message.model || "Job").toUpperCase()} was canceled.`
        );
      }

      refreshJobsSoon();
    };

    const scheduleReconnect = (connect) => {
      if (disposed || webSocketReconnectTimeoutRef.current) {
        return;
      }

      const attempt = webSocketReconnectAttemptRef.current;
      const delay = Math.min(
        WEBSOCKET_RECONNECT_BASE_MS * (2 ** attempt),
        WEBSOCKET_RECONNECT_MAX_MS
      );

      webSocketReconnectAttemptRef.current = attempt + 1;
      setWebSocketStatus("reconnecting");

      webSocketReconnectTimeoutRef.current = window.setTimeout(() => {
        webSocketReconnectTimeoutRef.current = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) {
        return;
      }

      const currentSocket = webSocketRef.current;
      if (
        currentSocket &&
        (
          currentSocket.readyState === WebSocket.OPEN ||
          currentSocket.readyState === WebSocket.CONNECTING
        )
      ) {
        return;
      }

      clearReconnectTimer();
      setWebSocketStatus(
        webSocketReconnectAttemptRef.current > 0
          ? "reconnecting"
          : "connecting"
      );
      setWebSocketError("");

      const socket = new WebSocket(webSocketUrl);
      webSocketRef.current = socket;

      socket.onopen = async () => {
        if (disposed || webSocketRef.current !== socket) {
          socket.close(1000, "Obsolete connection");
          return;
        }

        try {
          const session = await fetchAuthSession({ forceRefresh: true });
          const accessToken = session.tokens?.accessToken?.toString();

          if (!accessToken) {
            throw new Error(
              "No Cognito access token was available for live updates."
            );
          }

          socket.send(
            JSON.stringify({
              action: "register",
              access_token: accessToken,
            })
          );
        } catch (socketError) {
          setWebSocketStatus("error");
          setWebSocketError(
            socketError.message ||
              "Could not authenticate the live-update connection."
          );
          socket.close(4001, "Registration failed");
        }
      };

      socket.onmessage = (event) => {
        let message;

        try {
          message = JSON.parse(event.data);
        } catch {
          console.warn("Ignored a non-JSON WebSocket message.");
          return;
        }

        if (message.type === "registered") {
          webSocketReconnectAttemptRef.current = 0;
          setWebSocketStatus("connected");
          setWebSocketError("");
          void loadMyJobsRef.current?.({
            autoLoadCompletedResults: true,
          });
          return;
        }

        if (message.type === "registration_error") {
          setWebSocketStatus("error");
          setWebSocketError(
            message.message || "Live-update registration failed."
          );
          socket.close(4001, "Registration rejected");
          return;
        }

        if (message.type === "job_status_changed") {
          setWebSocketStatus("connected");
          setWebSocketError("");
          applyLiveJobUpdate(message);
          return;
        }

        if (message.type === "error") {
          setWebSocketError(
            message.message || "The live-update service returned an error."
          );
        }
      };

      socket.onerror = () => {
        if (!disposed) {
          setWebSocketError(
            "The live-update connection encountered a network error."
          );
        }
      };

      socket.onclose = () => {
        if (webSocketRef.current === socket) {
          webSocketRef.current = null;
        }

        if (!disposed) {
          scheduleReconnect(connect);
        }
      };
    };

    const reconnectWhenAvailable = () => {
      if (disposed) {
        return;
      }

      const socket = webSocketRef.current;
      const socketIsOpen =
        socket?.readyState === WebSocket.OPEN ||
        socket?.readyState === WebSocket.CONNECTING;

      if (!socketIsOpen) {
        clearReconnectTimer();
        connect();
      } else if (document.visibilityState === "visible") {
        void loadMyJobsRef.current?.({
          autoLoadCompletedResults: true,
        });
      }
    };

    // Delay the initial connection by one event-loop turn. In React
    // StrictMode, development builds run an extra setup/cleanup cycle.
    // The delay lets that test cleanup cancel the first attempt before a
    // WebSocket handshake starts.
    webSocketInitialConnectTimeoutRef.current = window.setTimeout(() => {
      webSocketInitialConnectTimeoutRef.current = null;
      connect();
    }, 0);

    window.addEventListener("online", reconnectWhenAvailable);
    window.addEventListener("focus", reconnectWhenAvailable);
    document.addEventListener("visibilitychange", reconnectWhenAvailable);

    return () => {
      disposed = true;

      if (webSocketInitialConnectTimeoutRef.current) {
        window.clearTimeout(webSocketInitialConnectTimeoutRef.current);
        webSocketInitialConnectTimeoutRef.current = null;
      }

      clearReconnectTimer();
      clearRefreshTimer();

      window.removeEventListener("online", reconnectWhenAvailable);
      window.removeEventListener("focus", reconnectWhenAvailable);
      document.removeEventListener(
        "visibilitychange",
        reconnectWhenAvailable
      );

      const socket = webSocketRef.current;
      webSocketRef.current = null;

      // Closing while readyState is CONNECTING causes Chrome to report
      // "WebSocket is closed before the connection is established."
      // A connecting socket is closed by socket.onopen after it becomes open.
      if (socket?.readyState === WebSocket.OPEN) {
        socket.close(1000, "Component unmounted");
      }
    };
  }, [signedInAs, isAdminView, webSocketUrl]);

  const addSelectedFiles = (candidateFiles) => {
    const incomingFiles = Array.from(candidateFiles || []);
    const acceptedFiles = incomingFiles.filter(isAcceptedInputFile);
    const rejectedFiles = incomingFiles.filter(
      (file) => !isAcceptedInputFile(file)
    );

    if (acceptedFiles.length > 0) {
      setFiles((previousFiles) =>
        mergeSelectedFiles(previousFiles, acceptedFiles)
      );
    }

    if (rejectedFiles.length > 0) {
      const rejectedNames = rejectedFiles
        .slice(0, 3)
        .map((file) => file.name)
        .join(", ");
      const extraCount = rejectedFiles.length - 3;

      setError(
        `Skipped unsupported file${rejectedFiles.length === 1 ? "" : "s"}: ` +
          `${rejectedNames}${extraCount > 0 ? ` and ${extraCount} more` : ""}. ` +
          "Only .zip, .tif, and .tiff files are accepted."
      );
    } else if (acceptedFiles.length > 0) {
      setError("");
    }
  };

  const handleFileSelection = (event) => {
    addSelectedFiles(event.target.files);
    event.target.value = "";
  };

  const handleDragEnter = (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (isSubmitting || !event.dataTransfer?.types?.includes("Files")) {
      return;
    }

    dragCounterRef.current += 1;
    setIsDraggingFiles(true);
  };

  const handleDragOver = (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (isSubmitting) {
      event.dataTransfer.dropEffect = "none";
      return;
    }

    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (isSubmitting) {
      return;
    }

    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);

    if (dragCounterRef.current === 0) {
      setIsDraggingFiles(false);
    }
  };

  const handleDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();

    dragCounterRef.current = 0;
    setIsDraggingFiles(false);

    if (isSubmitting) {
      return;
    }

    addSelectedFiles(event.dataTransfer?.files);
  };

  const openFilePicker = () => {
    if (!isSubmitting) {
      fileInputRef.current?.click();
    }
  };

  const handleDropZoneKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openFilePicker();
    }
  };

  const removeSelectedFile = (fileToRemove) => {
    setFiles((previousFiles) =>
      previousFiles.filter(
        (file) => getFileKey(file) !== getFileKey(fileToRemove)
      )
    );
  };

  const clearSelectedFiles = () => {
    setFiles([]);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleRun = async () => {
    setError("");
    setUploadInfo(null);
    setJobInfo(null);

    if (files.length === 0) {
      setError("Please choose one or more .zip, .tif, or .tiff files first.");
      return;
    }

    try {
      setIsSubmitting(true);

      setStep(
        files.length > 1
          ? "Creating ZIP from selected files..."
          : "Preparing selected file..."
      );
      const uploadFile = await prepareUploadFile(files, model);

      setStep("Creating S3 upload URL...");
      const uploadData = await createUploadUrl(uploadFile);
      setUploadInfo(uploadData);

      setStep("Uploading file to S3...");
      await uploadFileToS3(uploadData.upload_url, uploadFile);

      setStep("Adding job to queue...");
      const jobData = await startJob(model, uploadData.input_s3);
      setJobInfo(jobData);

      if (!jobData.job_id) {
        throw new Error("The backend did not return a job_id.");
      }

      setStep(
        "Job submitted. Track its live status in My Jobs below."
      );
      setMyJobsMessage(`Submitted ${jobData.job_id}.`);
      clearSelectedFiles();

      await loadMyJobs({
        autoLoadCompletedResults: true,
      });
      setMyJobsPollGeneration((previous) => previous + 1);
    } catch (runError) {
      setError(runError.message);
      setStep("Something went wrong.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmJobCancel = async () => {
    const job = jobToCancel;

    if (!job?.job_id) {
      setJobToCancel(null);
      return;
    }

    const jobId = job.job_id;
    setJobToCancel(null);
    setMyJobsError("");
    setMyJobsMessage("");
    setCancelingJobIds((previous) => ({
      ...previous,
      [jobId]: true,
    }));

    try {
      await stopJob(jobId);
      setMyJobsMessage(`Cancel request sent for ${jobId}.`);
      await loadMyJobs();
      setMyJobsPollGeneration((previous) => previous + 1);
    } catch (cancelError) {
      setMyJobsError(
        cancelError.message || `Could not cancel ${jobId}.`
      );
    } finally {
      setCancelingJobIds((previous) => ({
        ...previous,
        [jobId]: false,
      }));
    }
  };

  if (isAdminView) {
    return (
      <main className="page admin-page">
        <section className="card">
          <div className="app-title-row">
            <div>
              <h1>Admin Panel</h1>
              <p className="subtitle">
                Manage website users in a separate admin-only page.
              </p>
            </div>

            <div className="auth-panel">
              <span className="signed-in-as">Signed in as {signedInAs}</span>
              {isCheckingAdmin ? (
                <span className="admin-badge admin-badge-muted">
                  Checking role...
                </span>
              ) : (
                isAdmin && <span className="admin-badge">Admin</span>
              )}
              <a
                className="secondary-button auth-link-button"
                href={window.location.pathname}
              >
                Back to app
              </a>
              <button
                type="button"
                className="sign-out-button"
                onClick={signOut}
              >
                Sign out
              </button>
            </div>
          </div>
        </section>

        {isCheckingAdmin ? (
          <section className="card">
            <div className="status-box">Checking admin access...</div>
          </section>
        ) : isAdmin ? (
          <AdminPanel signedInAs={signedInAs} />
        ) : (
          <section className="card">
            <div className="error-box">
              Admin access required. Your account is signed in, but it is not in
              the {ADMIN_GROUP_NAME} Cognito group.
            </div>
          </section>
        )}
      </main>
    );
  }

  return (
    <main className="page">
      <section className="card">
        <div className="app-title-row">
          <div>
            <h1>Neuron Segmentation</h1>
            <p className="subtitle">
              Upload one or more images, or a ZIP file, run ANMAF or SWIN, and
              download the results.
            </p>
          </div>

          <div className="auth-panel">
            <span className="signed-in-as">Signed in as {signedInAs}</span>
            {isCheckingAdmin ? (
              <span className="admin-badge admin-badge-muted">
                Checking role...
              </span>
            ) : (
              isAdmin && <span className="admin-badge">Admin</span>
            )}
            {isAdmin && (
              <a
                className="admin-open-button"
                href={adminPanelUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Admin Panel
              </a>
            )}
            <button
              type="button"
              className="sign-out-button"
              onClick={signOut}
            >
              Sign out
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="model">Model</label>
          <select
            id="model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={isSubmitting}
          >
            <option value="anmaf">ANMAF</option>
            <option value="swin">SWIN</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="result-mode">Result files to show</label>
          <select
            id="result-mode"
            value={resultMode}
            onChange={(event) => setResultMode(event.target.value)}
          >
            <option value={RESULT_MODE_ZIP_ONLY}>ROI ZIP without PNG</option>
            <option value={RESULT_MODE_ZIP_AND_PNG}>
              ROI ZIP with PNG
            </option>
          </select>
          <p className="field-help">
            This controls which result links appear inside completed jobs.
          </p>
        </div>

        <div className="field">
          <label htmlFor="file">Input file(s)</label>

          <div
            className={[
              "file-drop-zone",
              isDraggingFiles ? "is-dragging" : "",
              isSubmitting ? "is-disabled" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={openFilePicker}
            onKeyDown={handleDropZoneKeyDown}
            role="button"
            tabIndex={isSubmitting ? -1 : 0}
            aria-disabled={isSubmitting}
            aria-describedby="file-drop-help"
          >
            <input
              id="file"
              ref={fileInputRef}
              className="file-drop-input"
              type="file"
              accept=".zip,.tif,.tiff,application/zip,image/tiff"
              multiple
              onChange={handleFileSelection}
              disabled={isSubmitting}
              tabIndex={-1}
            />

            <span className="file-drop-icon" aria-hidden="true">⇧</span>
            <strong>
              {isDraggingFiles
                ? "Drop the files here"
                : "Drag and drop files here"}
            </strong>
            <span className="file-drop-or">or</span>
            <span className="browse-files-button">Choose files</span>
            <span id="file-drop-help" className="file-drop-help">
              Accepts .zip, .tif, and .tiff files. You can add more files later.
            </span>
          </div>

          {files.length > 0 && (
            <div className="file-note">
              <div className="selected-files-header">
                <p>
                  Selected {files.length} file{files.length === 1 ? "" : "s"}:
                </p>
                <button
                  type="button"
                  className="clear-files-button"
                  onClick={clearSelectedFiles}
                  disabled={isSubmitting}
                >
                  Clear all
                </button>
              </div>

              <ul className="selected-files-list">
                {files.map((selectedFile) => (
                  <li key={getFileKey(selectedFile)}>
                    <span>{selectedFile.name}</span>
                    <button
                      type="button"
                      className="remove-file-button"
                      onClick={() => removeSelectedFile(selectedFile)}
                      disabled={isSubmitting}
                      aria-label={`Remove ${selectedFile.name}`}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>

              {files.length > 1 && (
                <p>These files will be zipped in the browser before upload.</p>
              )}
            </div>
          )}
        </div>

        <button
          className="run-button"
          onClick={handleRun}
          disabled={isSubmitting || files.length === 0}
        >
          {isSubmitting ? "Submitting..." : "Run Segmentation"}
        </button>

        <div className="status-box">
          <strong>Status:</strong> {step}
        </div>

        {error && <div className="error-box">{error}</div>}
      </section>

      <section className="card my-jobs-card">
        <div className="my-jobs-header">
          <div>
            <h2>My Jobs</h2>
            <p className="subtitle my-jobs-subtitle">
              Queued and running jobs return after a reload. Completed jobs and
              result links remain visible for two days.
            </p>
          </div>

          <div className="my-jobs-header-actions">
            <span
              className={`live-update-pill ${webSocketStatus}`}
              title={webSocketError || undefined}
            >
              <span className="live-update-dot" aria-hidden="true" />
              {getWebSocketStatusLabel(webSocketStatus)}
            </span>

            <button
              type="button"
              className="secondary-button"
              onClick={async () => {
                await loadMyJobs({ showLoading: true });
                setMyJobsPollGeneration((previous) => previous + 1);
              }}
              disabled={isLoadingMyJobs}
            >
              {isLoadingMyJobs ? "Refreshing..." : "Refresh jobs"}
            </button>
          </div>
        </div>

        {myJobsUpdatedAt && (
          <p className="my-jobs-updated">
            Last updated: {myJobsUpdatedAt.toLocaleTimeString()}
          </p>
        )}

        {myJobsMessage && (
          <div className="success-box">{myJobsMessage}</div>
        )}
        {myJobsError && <div className="error-box">{myJobsError}</div>}

        {isLoadingMyJobs && myJobs.length === 0 ? (
          <div className="status-box">Loading your jobs...</div>
        ) : myJobs.length === 0 ? (
          <div className="status-box">
            You do not have any visible jobs yet.
          </div>
        ) : (
          <div className="my-jobs-list">
            {myJobs.map((job) => {
              const jobId = job.job_id;
              const active = isActiveJob(job);
              const completed = isCompletedJob(job);
              const canceling = Boolean(cancelingJobIds[jobId]);
              const loadingResults = Boolean(loadingJobResults[jobId]);
              const downloadingAllResults = Boolean(
                downloadingJobResults[jobId]
              );
              const hasLoadedResults = Object.prototype.hasOwnProperty.call(
                jobResults,
                jobId
              );
              const allResults = jobResults[jobId] || [];
              const visibleJobResults = filterResults(
                allResults,
                resultMode
              );
              const statusText =
                job.status || job.dynamodb_status || "Unknown";

              return (
                <article className="my-job-item" key={jobId}>
                  <div className="my-job-title-row">
                    <div>
                      <h3>{(job.model || "Job").toUpperCase()}</h3>
                      <p className="my-job-id">{jobId}</p>
                    </div>
                    <span
                      className={`job-status-pill ${getJobStatusClass(job)}`}
                    >
                      {statusText}
                    </span>
                  </div>

                  <div className="my-job-meta-grid">
                    <div>
                      <span>Submitted</span>
                      <strong>{formatDate(job.created_at)}</strong>
                    </div>
                    <div>
                      <span>Started</span>
                      <strong>{formatDate(job.started_at)}</strong>
                    </div>
                    <div>
                      <span>Finished</span>
                      <strong>{formatDate(job.finished_at)}</strong>
                    </div>
                    <div>
                      <span>Started by</span>
                      <strong>
                        {job.user_display_name || signedInAs}
                      </strong>
                    </div>
                  </div>

                  {job.failure_reason && (
                    <div className="row-feedback error">
                      {job.failure_reason}
                    </div>
                  )}

                  {job.refresh_error && (
                    <div className="row-feedback warning">
                      {job.refresh_error}
                    </div>
                  )}

                  <div className="my-job-actions">
                    {active && job.can_cancel !== false && (
                      <button
                        type="button"
                        className="small-danger-button"
                        onClick={() => setJobToCancel(job)}
                        disabled={canceling}
                      >
                        {canceling ? "Canceling..." : "Cancel job"}
                      </button>
                    )}

                    {completed && job.output_s3 && (
                      <button
                        type="button"
                        className="small-button"
                        onClick={() =>
                          loadResultsForJob(job, { force: true })
                        }
                        disabled={loadingResults || downloadingAllResults}
                      >
                        {loadingResults
                          ? "Loading results..."
                          : hasLoadedResults
                            ? "Refresh results"
                            : "Load results"}
                      </button>
                    )}

                    {completed && hasLoadedResults && visibleJobResults.length > 0 && (
                      <button
                        type="button"
                        className="small-button download-all-results-button"
                        onClick={() =>
                          downloadAllResultsForJob(job, visibleJobResults)
                        }
                        disabled={loadingResults || downloadingAllResults}
                      >
                        {downloadingAllResults
                          ? "Preparing download..."
                          : "Download all files"}
                      </button>
                    )}
                  </div>

                  {jobDownloadErrors[jobId] && (
                    <div className="row-feedback error job-download-error">
                      {jobDownloadErrors[jobId]}
                    </div>
                  )}

                  {completed && (
                    <div className="my-job-results">
                      <h4>Result files</h4>

                      {loadingResults && !hasLoadedResults ? (
                        <div className="status-box">
                          Loading result files...
                        </div>
                      ) : jobResultErrors[jobId] ? (
                        <div className="error-box">
                          {jobResultErrors[jobId]}
                        </div>
                      ) : hasLoadedResults &&
                        visibleJobResults.length === 0 ? (
                        <div className="status-box">
                          No files match the selected result option.
                        </div>
                      ) : hasLoadedResults ? (
                        <ul className="results-list">
                          {visibleJobResults.map((item) => (
                            <li key={item.key}>
                              <a
                                href={item.download_url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {getResultDisplayName(item.key)}
                              </a>
                              <span>{item.size} bytes</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="field-help">
                          Result links will load automatically. Use Load
                          results if they do not appear.
                        </p>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <details className="card details-card">
        <summary className="details-summary">
          <span>Backend details</span>
          <span className="details-arrow" aria-hidden="true">▾</span>
        </summary>

        <div className="details-body">
          <p>
            <strong>API:</strong> {apiBaseUrl}
          </p>
          <p>
            <strong>Signed in as:</strong> {signedInAs}
          </p>
          <p>
            <strong>WebSocket:</strong> {webSocketUrl}
          </p>
          <p>
            <strong>Live-update status:</strong>{" "}
            {getWebSocketStatusLabel(webSocketStatus)}
            {webSocketError ? ` — ${webSocketError}` : ""}
          </p>
          {uploadInfo?.input_s3 && (
            <p>
              <strong>Latest input S3:</strong> {uploadInfo.input_s3}
            </p>
          )}
          {jobInfo?.job_id && (
            <p>
              <strong>Latest submitted job ID:</strong> {jobInfo.job_id}
            </p>
          )}
          {jobInfo?.output_s3 && (
            <p>
              <strong>Latest output S3:</strong> {jobInfo.output_s3}
            </p>
          )}
        </div>
      </details>

      {jobToCancel && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-job-title"
          >
            <h2 id="cancel-job-title">Cancel job?</h2>
            <p>
              Are you sure you want to cancel{" "}
              <strong>{jobToCancel.job_id}</strong>?
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="confirm-no-button"
                onClick={() => setJobToCancel(null)}
              >
                No
              </button>
              <button
                type="button"
                className="confirm-yes-button"
                onClick={handleConfirmJobCancel}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

const authenticatorComponents = {
  SignIn: {
    Footer() {
      return null;
    },
  },
};

function App() {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((currentTheme) =>
      currentTheme === "dark" ? "light" : "dark"
    );
  };

  return (
    <div className="app-root">
      <div className="theme-toolbar">
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

      <Authenticator hideSignUp components={authenticatorComponents}>
        {({ signOut, user }) => (
          <SegmentationApp signOut={signOut} user={user} />
        )}
      </Authenticator>
    </div>
  );
}

export default App;
