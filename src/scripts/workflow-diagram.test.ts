// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { renderWorkflowDiagram } from "./workflow-diagram";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg><g class="node" id="flowchart-inspect-0"></g></svg>' })),
  },
}));

describe("workflow diagram renderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = `<figure data-workflow-diagram>
      <div class="workflow-diagram__canvas"></div><p class="workflow-diagram__status">Rendering workflow…</p>
      <script data-workflow-source>flowchart LR\n  inspect[Inspect]</script>
      <script data-workflow-nodes>[{"id":"inspect","title":"Inspect","kind":"step","details":[{"label":"Description","value":"Inspect the change."},{"label":"Agent","value":"Reviewer"}]}]</script>
      <dialog data-workflow-node-dialog><h2 data-node-title></h2><dl data-node-details></dl></dialog>
    </figure>`;
  });

  it("renders Mermaid and makes declared nodes interactive", async () => {
    const diagram = document.querySelector<HTMLElement>("[data-workflow-diagram]")!;
    await renderWorkflowDiagram(diagram, "catalog-workflow", undefined, false);
    expect(mermaid.render).toHaveBeenCalledWith("catalog-workflow-lr", expect.stringContaining("inspect[Inspect]"));
    const node = diagram.querySelector<SVGGElement>("g.node");
    expect(node?.getAttribute("role")).toBe("button");
    expect(node?.getAttribute("aria-label")).toBe("View details for Inspect");
    expect(diagram.querySelector(".workflow-diagram__status")?.textContent).toBe("");
  });

  it("renders a native vertical timeline instead of Mermaid on narrow screens", async () => {
    const diagram = document.querySelector<HTMLElement>("[data-workflow-diagram]")!;
    const dialog = diagram.querySelector<HTMLDialogElement>("dialog")!;
    dialog.showModal = vi.fn();
    await renderWorkflowDiagram(diagram, "catalog-workflow", undefined, true);
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(diagram.querySelector(".workflow-diagram__steps")).not.toBeNull();
    expect(diagram.querySelector(".workflow-diagram__step-marker")).not.toBeNull();
    expect(diagram.querySelector(".workflow-diagram__step-title")?.textContent).toBe("Inspect");
    expect(diagram.querySelector(".workflow-diagram__step-description")?.textContent).toBe("Inspect the change.");
    expect(diagram.querySelector(".workflow-diagram__step-meta")?.textContent).toBe("Agent: Reviewer");
    diagram.querySelector<HTMLButtonElement>(".workflow-diagram__step-control")?.click();
    expect(dialog.querySelector("[data-node-title]")?.textContent).toBe("Inspect");
    expect(dialog.showModal).toHaveBeenCalledOnce();
  });
});
