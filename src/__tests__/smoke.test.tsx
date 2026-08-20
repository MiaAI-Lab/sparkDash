import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

describe("vitest smoke test", () => {
  it("renders a div into the document", () => {
    render(<div>hello sparkdash</div>);
    expect(screen.getByText("hello sparkdash")).toBeInTheDocument();
  });
});
