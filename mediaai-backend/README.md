# Bundled Media AI Backend

This directory vendors the OmniGen FastAPI backend used by OrianBuilder's Media
AI screen.

The app packages this directory through Electron Forge `extraResource`. Runtime
dependencies, Hugging Face model files, and generated outputs are stored under
the Electron user data directory instead of this source directory, so packaged
apps can run from read-only installation locations.

Use the Media AI screen in the app to:

- create the backend Python virtual environment;
- install `backend/requirements.txt`;
- download text, image, audio, and video model groups;
- start or stop the local FastAPI server.

Default local API:

- `GET /health`
- `POST /generate/text`
- `POST /generate/image`
- `POST /generate/audio`
- `POST /generate/video`
