/**
 * Page object for model picker functionality.
 * Handles model and provider selection.
 */

import { expect, Page } from "@playwright/test";

export class ModelPicker {
  constructor(public page: Page) {}

  async selectModel({ provider, model }: { provider: string; model: string }) {
    await this.page.getByTestId("model-picker").click();
    await this.page.getByText(provider, { exact: true }).click();
    await this.page.getByText(model, { exact: true }).click();
  }

  async selectTestModel() {
    await this.page.getByTestId("model-picker").click();
    const providerItem = this.page.getByText("test-provider");
    await expect(providerItem).toBeVisible();
    await providerItem.click();
    const modelItem = this.page.getByText("test-model");
    await expect(modelItem).toBeVisible();
    await modelItem.click();
  }

  async selectTestModelViaIpc() {
    await this.page.evaluate(async () => {
      const providers = (await (window as any).electron.ipcRenderer.invoke(
        "get-language-model-providers",
      )) as Array<{ id: string; name: string }>;
      const provider = providers.find(
        (candidate) => candidate.name === "test-provider",
      );
      if (!provider) throw new Error("E2E test provider was not created");
      const models = (await (window as any).electron.ipcRenderer.invoke(
        "get-language-models",
        { providerId: provider.id },
      )) as Array<{ id?: number; apiName: string }>;
      const model = models.find(
        (candidate) => candidate.apiName === "test-model",
      );
      if (!model) throw new Error("E2E test model was not created");
      await (window as any).electron.ipcRenderer.invoke("set-user-settings", {
        selectedModel: {
          name: "test-model",
          provider: provider.id,
          customModelId: model.id,
        },
      });
    });
  }

  async selectTestOllamaModel() {
    await this.page.getByTestId("model-picker").click();
    await this.page.getByText("Local models").click();
    await this.page.getByText("Ollama", { exact: true }).click();
    await this.page.getByText("Testollama", { exact: true }).click();
  }

  async selectTestLMStudioModel() {
    await this.page.getByTestId("model-picker").click();
    await this.page.getByText("Local models").click();
    await this.page.getByText("LM Studio", { exact: true }).click();
    // Both of the elements that match "lmstudio-model-1" are the same button, so we just pick the first.
    await this.page
      .getByText("lmstudio-model-1", { exact: true })
      .first()
      .click();
  }

  async selectTestAzureModel() {
    await this.page.getByTestId("model-picker").click();
    await this.page.getByText("Other AI providers").click();
    await this.page.getByText("Azure OpenAI", { exact: true }).click();
    await this.page.getByText("GPT-5", { exact: true }).click();
  }
}
