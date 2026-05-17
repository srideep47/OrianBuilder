module.exports = {
  expo: {
    name: "ExpoApp",
    slug: "expo-app",
    version: "1.0.0",
    orientation: "portrait",
    newArchEnabled: false,
    ios: {
      supportsTablet: true,
    },
    android: {
      package: "com.orianbuilder.expoapp",
      edgeToEdgeEnabled: true,
    },
    web: {
      bundler: "metro",
      output: "static",
    },
    plugins: ["expo-router"],
    experiments: {
      typedRoutes: true,
    },
  },
};
