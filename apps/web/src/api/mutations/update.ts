import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { APP_PATH_PREFIX } from "../paths";
import { appKeys } from "../queries";

/** The requests the update routes of the app take. */
export type UpdateRequest = "install" | "restart" | "wait";

/** A request the app refused, answered with an error status, or never received. */
export class UpdateRequestError extends Error {
  constructor(request: UpdateRequest, cause?: unknown) {
    super(`The app did not accept the update request "${request}".`, { cause });
    this.name = "UpdateRequestError";
  }
}

async function send(request: UpdateRequest): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${APP_PATH_PREFIX}/update/${request}`, { method: "POST" });
  } catch (error) {
    throw new UpdateRequestError(request, error);
  }

  if (!response.ok) {
    throw new UpdateRequestError(request);
  }
}

/** One request to the update routes. The state it changes is read again after it. */
export function updateRequestOptions(queryClient: QueryClient, request: UpdateRequest) {
  return mutationOptions<void, UpdateRequestError>({
    mutationKey: [...appKeys.update(), request],
    mutationFn: () => send(request),
    onSettled: () => queryClient.invalidateQueries({ queryKey: appKeys.update() }),
  });
}
