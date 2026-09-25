// The routes over the workflows of one tree: the names it holds, one workflow,
// one step of it with the document its file holds, and the create, the edit and
// the delete of one workflow.

import {
  createWorkflow,
  openTreeWorkflows,
  openWritableWorkflows,
  removedStepNotesOfTree,
  removeWorkflow,
  updateWorkflow,
} from "@tasma/engine";
import type { WorkflowChange as EngineWorkflowChange, WorkflowInput as EngineWorkflowInput } from "@tasma/engine";
import { routes } from "@tasma/protocol";
import type { Diagnostic, StepDefinition, Success, Workflow, WorkflowReceipt } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import { assertNoQuery } from "../tasks/filter.js";
import { toChange } from "../tasks/input.js";
import { CONFIG_KEY, type WriteQueue, workflowKey } from "../tasks/serialize.js";

/**
 * The notes of the tasks on a removed step. They are advisory and the edit is
 * already written, so a fault of the read answers no notes rather than a failure.
 */
async function removedStepNotes(root: string | undefined, workflow: string, removed: string[]): Promise<Diagnostic[]> {
  try {
    return await removedStepNotesOfTree(workflow, removed, { root });
  } catch {
    return [];
  }
}

/**
 * The workflow routes, against the entries the contract declares.
 *
 * The routes take the tree rather than the project host: they hold no index, so
 * `host.close()` does not reach them and the reads still answer once a shutdown
 * has closed every project, as `/health` does.
 *
 * The handle is opened per request and holds nothing between calls, so a hand
 * edit to a workflow file is seen by the next request. The diagnostics of
 * resolving the configuration come before those of the call itself, which is the
 * order they happened in.
 *
 * Each write takes the turn of its workflow in the queue the project routes
 * share, where a project edit that states `workflows` takes the turn of every
 * workflow it names, so no project can come to list a workflow a delete is
 * removing. It also takes the turn of the user's configuration, which places the
 * workflows directory.
 */
export function workflowRoutes(options: { root?: string; writes: WriteQueue }): RouteEntry[] {
  const { root, writes } = options;
  const inTurn = <T>(name: string, write: () => Promise<T>) => writes.runAll([CONFIG_KEY, workflowKey(name)], write);

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
    {
      route: routes.createWorkflow,
      handler: async (request): Promise<Success<Workflow>> => {
        assertNoQuery(request.query);
        // The engine checks every key and every value at run time; the name is
        // checked by the handle before it becomes a path.
        const { name: statedName, ...input } = toChange(request.body);
        const name = typeof statedName === "string" ? statedName : "";
        return inTurn(name, async () => {
          const workflows = await openWritableWorkflows(root);
          const { workflow, diagnostics } = await createWorkflow(workflows, name, input as EngineWorkflowInput);
          return { data: workflow, diagnostics };
        });
      },
    },
    {
      route: routes.updateWorkflow,
      handler: async (request): Promise<Success<Workflow>> => {
        assertNoQuery(request.query);
        const name = request.params.workflow!;
        const change = toChange(request.body) as EngineWorkflowChange;
        // The notes are read inside the turn, so they describe the file this
        // edit wrote.
        return inTurn(name, async () => {
          const workflows = await openWritableWorkflows(root);
          const { workflow, diagnostics, removedSteps } = await updateWorkflow(workflows, name, change);
          const notes = await removedStepNotes(root, name, removedSteps);
          return { data: workflow, diagnostics: [...diagnostics, ...notes] };
        });
      },
    },
    {
      route: routes.deleteWorkflow,
      handler: async (request): Promise<Success<WorkflowReceipt>> => {
        assertNoQuery(request.query);
        const name = request.params.workflow!;
        return inTurn(name, async () => {
          await removeWorkflow(name, { root });
          return { data: { name }, diagnostics: [] };
        });
      },
    },
  ];
}
