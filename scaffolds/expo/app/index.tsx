import { StyleSheet, Text, View } from "react-native";

// ⚠ PLACEHOLDER — YOU MUST replace this entire file with the app content
// the user requested. Do NOT run QA or package an APK until this is done.
export default function HomeScreen() {
  return (
    <View style={styles.screen}>
      <Text style={styles.heading}>⚠ PLACEHOLDER</Text>
      <Text style={styles.body}>
        This is the scaffold starter screen. Replace app/index.tsx with the
        requested app content before running QA or building an APK.
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
    backgroundColor: "#fff3cd",
  },
  heading: {
    fontSize: 30,
    fontWeight: "900",
    color: "#856404",
    textAlign: "center",
    letterSpacing: 2,
  },
  body: {
    fontSize: 14,
    color: "#664d03",
    textAlign: "center",
    maxWidth: 280,
    lineHeight: 22,
  },
});
