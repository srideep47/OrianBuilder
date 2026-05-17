import { StyleSheet, Text, View } from "react-native";

export default function HomeScreen() {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Welcome</Text>
      <Text style={styles.subtitle}>
        Your Expo app is ready. Edit app/index.tsx to build the requested mobile
        experience.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
    backgroundColor: "#eef2ff",
  },
  title: {
    color: "#4338ca",
    fontSize: 42,
    fontWeight: "800",
    textAlign: "center",
  },
  subtitle: {
    maxWidth: 320,
    color: "#475569",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
});
