import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { AvatarImage, __resetAvatarFailuresForTest } from "./avatar-image";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("skynet_auth", JSON.stringify({ loggedIn: true, username: "ashley" }));
  __resetAvatarFailuresForTest();
});

describe("AvatarImage", () => {
  it("renders the image while it loads", () => {
    const { container, queryByTestId } = render(<AvatarImage src="/a.png" name="willow" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/a.png");
    expect(queryByTestId("avatar-initial")).toBeNull();
  });

  it("swaps to the initial when the image fails to load", () => {
    const { container, getByTestId } = render(
      <AvatarImage src="/missing.png" name="willow" initialClassName="disc" />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(getByTestId("avatar-initial").textContent).toBe("W");
    expect(getByTestId("avatar-initial").className).toBe("disc");
  });

  it("tries again when the src changes", () => {
    const { container, rerender } = render(<AvatarImage src="/missing.png" name="willow" />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<AvatarImage src="/new.png" name="willow" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("/new.png");
  });

  it("shows the initial with no src, and '?' with no name", () => {
    const { getByTestId, rerender } = render(<AvatarImage src="" name="duet" />);
    expect(getByTestId("avatar-initial").textContent).toBe("D");
    rerender(<AvatarImage src={null} name="" />);
    expect(getByTestId("avatar-initial").textContent).toBe("?");
  });

  it("a src that failed on an earlier load paints the initial straight away", () => {
    const first = render(<AvatarImage src="/none.png" name="sonar" />);
    fireEvent.error(first.container.querySelector("img")!);
    first.unmount();
    __resetAvatarFailuresForTest(); // as on a fresh page load
    const { container, getByTestId } = render(<AvatarImage src="/none.png" name="sonar" />);
    expect(container.querySelector("img")).toBeNull();
    expect(getByTestId("avatar-initial").textContent).toBe("S");
  });

  it("a src that loads is no longer remembered as failed", () => {
    const first = render(<AvatarImage src="/flaky.png" name="sonar" />);
    fireEvent.error(first.container.querySelector("img")!);
    first.unmount();
    const second = render(<AvatarImage src="/other.png" name="x" />);
    second.rerender(<AvatarImage src="/flaky.png" name="x" />);
    expect(second.container.querySelector("img")).toBeNull();
    second.unmount();
    localStorage.removeItem("skynet:avatar-failed-srcs:v2");
    __resetAvatarFailuresForTest();
    const third = render(<AvatarImage src="/flaky.png" name="x" />);
    fireEvent.load(third.container.querySelector("img")!);
    __resetAvatarFailuresForTest();
    const fourth = render(<AvatarImage src="/flaky.png" name="x" />);
    expect(fourth.container.querySelector("img")).not.toBeNull();
  });

  it("one person's remembered failures don't apply to another person on the same device", () => {
    const first = render(<AvatarImage src="/none.png" name="sonar" />);
    fireEvent.error(first.container.querySelector("img")!);
    first.unmount();
    localStorage.setItem("skynet_auth", JSON.stringify({ loggedIn: true, username: "zoey" }));
    const { container } = render(<AvatarImage src="/none.png" name="sonar" />);
    expect(container.querySelector("img")).not.toBeNull();
  });
});
