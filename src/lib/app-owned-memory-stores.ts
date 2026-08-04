import {
  registerRetainedStore,
  type RetainedStoreRegistration,
} from "./app-owned-memory";
import {
  evictOldestResponseContinuationForBudget,
  responseContinuationRetainedStoreSnapshot,
} from "../responses/state";

const RESPONSE_CONTINUATION_STORE: RetainedStoreRegistration = {
  id: "responses_continuation",
  category: "continuation",
  snapshot: responseContinuationRetainedStoreSnapshot,
  evictOldest: evictOldestResponseContinuationForBudget,
};

let registered = false;

export function registerDefaultAppOwnedMemoryStores(): void {
  if (registered) return;
  registered = true;
  registerRetainedStore(RESPONSE_CONTINUATION_STORE);
}
