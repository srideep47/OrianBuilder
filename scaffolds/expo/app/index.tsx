import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

/**
 * Default Expo Router entry screen. This is a working baseline so the build
 * pipeline (export → preview → APK) always succeeds out of the box. Customize
 * this file to match your app — replace the layout, copy, and logic with
 * whatever the user requested. The styles below use plain React Native
 * primitives so the app runs on web, iOS, and Android without extra setup.
 */
export default function HomeScreen() {
  const [count, setCount] = useState(0);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Welcome</Text>
      <Text style={styles.subtitle}>
        Your Expo app is running. Edit{" "}
        <Text style={styles.code}>app/index.tsx</Text> to customize this screen.
      </Text>

      <View style={styles.counterCard}>
        <Text style={styles.counterLabel}>Counter</Text>
        <Text style={styles.counterValue}>{count}</Text>
        <View style={styles.buttonRow}>
          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.buttonSecondary,
              pressed && styles.buttonPressed,
            ]}
            onPress={() => setCount((value) => Math.max(0, value - 1))}
            accessibilityRole="button"
            accessibilityLabel="Decrement counter"
          >
            <Text style={styles.buttonText}>−</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.buttonPrimary,
              pressed && styles.buttonPressed,
            ]}
            onPress={() => setCount((value) => value + 1)}
            accessibilityRole="button"
            accessibilityLabel="Increment counter"
          >
            <Text style={styles.buttonText}>＋</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 20,
    padding: 24,
    backgroundColor: "#0b0d12",
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#f8fafc",
  },
  subtitle: {
    fontSize: 14,
    color: "#94a3b8",
    textAlign: "center",
    maxWidth: 320,
    lineHeight: 20,
  },
  code: {
    fontFamily: "Courier",
    color: "#e2e8f0",
    backgroundColor: "#1e293b",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  counterCard: {
    marginTop: 16,
    alignItems: "center",
    backgroundColor: "#111827",
    paddingVertical: 24,
    paddingHorizontal: 28,
    borderRadius: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: "#1f2937",
    minWidth: 260,
  },
  counterLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#94a3b8",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  counterValue: {
    fontSize: 48,
    fontWeight: "800",
    color: "#f8fafc",
  },
  buttonRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 4,
  },
  button: {
    width: 56,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
  buttonPrimary: {
    backgroundColor: "#6366f1",
  },
  buttonSecondary: {
    backgroundColor: "#374151",
  },
  buttonPressed: {
    opacity: 0.75,
  },
  buttonText: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: "700",
  },
});
