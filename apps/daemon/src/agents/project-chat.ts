/** The part of the system prompt of a project chat that all agents share. */
export function projectChatContext(tag: string): string {
  return `This chat runs in the Tasma app, a local task manager. The chat belongs to the Tasma project with the tag ${tag}, and your working directory is the folder of this project. The chat has no task and no workflow step.

Before you act on a request about tasks, comments, projects or workflows, load the tasma skill. If the skill is not available, use \`tasma --help\`.

Treat each message as a direct request, and do what the user asks. Do not start a task, set a step or run a workflow step unless the user asks for it.`;
}
