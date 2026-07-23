# Neuron Segmentation Frontend

This version uses Vite instead of Create React App/react-scripts. That removes the deprecated webpack-dev-server warnings from the old CRA setup.

## Install

```bash
npm install
```

## Run locally

```bash
npm start
```

Open the local URL shown in the terminal, usually http://localhost:5173.

## Build for Amplify/manual deploy

```bash
npm run build
```

The production files will be in the `dist` folder.

If you are doing a manual Amplify upload, zip the contents of `dist`, not the folder itself:

```bash
cd dist
zip -r ../frontend-build.zip .
cd ..
```

## API URL override

The app uses this API by default:

```text
https://qzd88m0dib.execute-api.us-east-2.amazonaws.com
```

To override it locally, create a `.env` file:

```text
VITE_API_BASE_URL=https://your-api-url.example.com
```
