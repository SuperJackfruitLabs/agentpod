import { describe, expect, it } from "vitest";
import { enrollmentCommand, INSTALLER_URL } from "./enrollment-command";

describe("enrollmentCommand", () => {
  it("downloads the installer from the organization's repository, not the old personal one", () => {
    expect(INSTALLER_URL).toBe("https://github.com/SuperJackfruitLabs/agentpod/releases/latest/download/install.sh");
    expect(enrollmentCommand("https://hub.example", "tok")).toBe(`curl -fsSL ${INSTALLER_URL} | sudo bash -s -- https://hub.example tok`);
  });
});
