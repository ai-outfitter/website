import { describe, expect, it } from "vitest";
import { removeSource, setSourceRef, summarizeSettings } from "./settings";

const settings = `# account configuration
default_agent: engineer
sources:
  # private catalog
  - github: example/private
    ref: main
  - path: ./local
remote_settings:
  - github: example/shared
    path: settings.yml
    ref: v1
unrelated:
  enabled: true
`;

describe("settings.yml document edits", () => {
  it("summarizes direct and remote sources", () => {
    expect(summarizeSettings(settings)).toMatchObject({ valid: true, defaults: { agent: "engineer" }, sources: [
      { id: "sources:0", kind: "github", github: "example/private", ref: "main" },
      { id: "sources:1", kind: "path", path: "./local" },
      { id: "remote_settings:0", kind: "github", github: "example/shared", ref: "v1" },
    ] });
  });

  it("updates one ref without discarding comments, order, or unrelated keys", () => {
    const updated = setSourceRef(settings, "sources:0", "v2");
    expect(updated).toContain("# account configuration");
    expect(updated).toContain("# private catalog");
    expect(updated.indexOf("default_agent")).toBeLessThan(updated.indexOf("sources:"));
    expect(updated).toContain("ref: v2");
    expect(updated).toContain("unrelated:");
  });

  it("removes only the selected source", () => {
    const updated = removeSource(settings, "sources:1");
    expect(updated).not.toContain("./local");
    expect(updated).toContain("example/private");
    expect(updated).toContain("example/shared");
  });
});
