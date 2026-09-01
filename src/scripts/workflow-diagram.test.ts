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
    document.body.innerHTML = `<figure data-workflow-diagram>
      <div class="workflow-diagram__canvas"></div><p class="workflow-diagram__status">Rendering workflow…</p>
      <script data-workflow-source>flowchart LR\n  inspect[Inspect]</script>
      <script data-workflow-nodes>[{"id":"inspect","title":"Inspect","kind":"step","details":[]}]</script>
      <dialog data-workflow-node-dialog><h2 data-node-title></h2><dl data-node-details></dl></dialog>
    </figure>`;
  });

  it("renders Mermaid and makes declared nodes interactive", async () => {
    const diagram = document.querySelector<HTMLElement>("[data-workflow-diagram]")!;
    await renderWorkflowDiagram(diagram, "catalog-workflow");
    expect(mermaid.render).toHaveBeenCalledWith("catalog-workflow-lr", expect.stringContaining("inspect[Inspect]"));
    const node = diagram.querySelector<SVGGElement>("g.node");
    expect(node?.getAttribute("role")).toBe("button");
    expect(node?.getAttribute("aria-label")).toBe("View details for Inspect");
    expect(diagram.querySelector(".workflow-diagram__status")?.textContent).toBe("");
  });
});
