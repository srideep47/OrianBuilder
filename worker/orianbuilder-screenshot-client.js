(() => {
  async function captureScreenshot() {
    try {
      // Use html-to-image if available
      if (typeof htmlToImage !== "undefined") {
        return await htmlToImage.toPng(document.body, {
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        });
      }
      throw new Error("html-to-image library not found");
    } catch (error) {
      console.error(
        "[orianbuilder-screenshot] Failed to capture screenshot:",
        error,
      );
      throw error;
    }
  }
  async function handleScreenshotRequest(requestId) {
    try {
      console.debug("[orianbuilder-screenshot] Capturing screenshot...");

      const dataUrl = await captureScreenshot();

      console.debug(
        "[orianbuilder-screenshot] Screenshot captured successfully",
      );

      // Send success response to parent
      window.parent.postMessage(
        {
          type: "orianbuilder-screenshot-response",
          requestId,
          success: true,
          dataUrl: dataUrl,
        },
        "*",
      );
    } catch (error) {
      console.error(
        "[orianbuilder-screenshot] Screenshot capture failed:",
        error,
      );

      // Send error response to parent
      window.parent.postMessage(
        {
          type: "orianbuilder-screenshot-response",
          requestId,
          success: false,
          error: error.message,
        },
        "*",
      );
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;

    if (event.data.type === "orianbuilder-take-screenshot") {
      handleScreenshotRequest(event.data.requestId);
    }
  });
})();
