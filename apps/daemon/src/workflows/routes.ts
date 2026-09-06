// The routes over the workflows of one tree: the names it holds, one workflow,
// and one step of it with the document its file holds.

import { openTreeWorkflows } from "@tasma/engine";
import { routes } from "@tasma/protocol";
import type { StepDefinition, Success, Workflow } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import { assertNoQuery } from "../tasks/filter.js";

/**
 * The workflow routes, against the entries the contract declares.
 *
 * They take the tree rather than the project host: they hold no index and open
 * no project, so `host.close()` does not reach them and they still answer once a
 * shutdown has closed every project, as `/health` does.
 *
 * The handle is opened per request and holds nothing between calls, so a hand
 * edit to a workflow file is seen by the next request. All three are reads, so
 * none takes a turn in a write queue. The diagnostics of resolving the
 * configuration come before those of the call itself, which is the order they
 * happened in.
 */
export function workflowRoutes(options: { root?: string }): RouteEntry[] {
  const { root } = options;

  return [
    {
      route: routes.listWorkflows,
      handler: async (request): Promise<Success<string[]>> => {
        assertNoQuery(request.query);
        const { workflows, diagnostics } = await openTreeWorkflows(root);
        const { names, diagnostics: listed } = await workflows.list();
        return { data: names, diagnostics: [...diagnostics, ...listed] };
      },
    },
    {
      route: routes.readWorkflow,
      handler: async (request): Promise<Success<Workflow>> => {
        assertNoQuery(request.query);
        const { workflows, diagnostics } = await openTreeWorkflows(root);
        const { workflow, diagnostics: read } = await workflows.read(request.params.workflow!);
        return { data: workflow, diagnostics: [...diagnostics, ...read] };
      },
    },
    {
      route: routes.readWorkflowStep,
      handler: async (request): Promise<Success<StepDefinition>> => {
        assertNoQuery(request.query);
        const { workflows, diagnostics } = await openTreeWorkflows(root);
        const { step, document, diagnostics: read } = await workflows.readStep(
          request.params.workflow!,
          request.params.step!,
        );
        return { data: { step, document }, diagnostics: [...diagnostics, ...read] };
      },
    },
  ];
}
