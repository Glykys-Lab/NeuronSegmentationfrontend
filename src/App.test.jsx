import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import App from "./App.jsx";

test("renders neuron segmentation title", () => {
  render(<App />);
  expect(screen.getByText(/neuron segmentation/i)).toBeInTheDocument();
});
