/** The words of the task-delete dialog, the same on the board and on the task page. */
export function deleteTaskWords(id: string, title: string): { title: string; description: string } {
  return {
    title: `Delete ${id}?`,
    // Typographic quotes, so a title holding a straight quote still reads as one string.
    description: `“${title}” will be removed from disk. There is no undo.`,
  };
}
