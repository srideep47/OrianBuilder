import { registerAppDockerHandlers } from "./app/app_docker_handler";
import { registerAppExecutionHandlers } from "./app/app_execution_handler";
import { registerAppGitHandlers } from "./app/app_git_handler";
import { registerAppLifecycleHandlers } from "./app/app_lifecycle_handler";
import { registerAppPreviewHandlers } from "./app/app_preview_handler";

export { runAppById, stopAppById } from "./app/app_execution_handler";

export function registerAppHandlers() {
  registerAppLifecycleHandlers();
  registerAppExecutionHandlers();
  registerAppGitHandlers();
  registerAppPreviewHandlers();
  registerAppDockerHandlers();
}
