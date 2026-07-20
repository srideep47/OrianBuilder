import { systemContracts } from "../types/system";
import { createTypedHandler } from "./base";

/**
 * Credit budgets belong to the optional hosted service. Local-first Orion
 * installations have no paid budget, so expose the contract as `null` instead
 * of leaving the renderer to call an unregistered IPC channel on every launch.
 */
export function registerUserBudgetHandlers(): void {
  createTypedHandler(systemContracts.getUserBudget, async () => null);
}
