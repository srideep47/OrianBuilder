# AI Rules — Expo (React Native)

## ⚠ MANDATORY FIRST STEP AFTER SCAFFOLDING

1. **Read `app/index.tsx`** — it contains an obvious yellow PLACEHOLDER screen.
2. **Replace it** with the actual app content the user requested using React Native
   components and `StyleSheet`.
3. Only run `npm run preview` / QA **after** your content is visible in the app.
4. **Never package a PLACEHOLDER as an APK.** If the QA screenshot or
   accessibility tree still shows "PLACEHOLDER" or the warning yellow screen,
   you have not implemented the app yet — go back to step 2.

---

## Project overview

- **Runtime**: React Native (Expo SDK 53) + expo-router v5
- **Styling**: React Native `StyleSheet` (built-in — no Tailwind, no NativeWind)
- **Language**: TypeScript (strict)
- **Navigation**: expo-router v5 (file-based routing, like Next.js App Router for native)

## Expo Router — file-based routing

| File                     | Route                    |
| ------------------------ | ------------------------ |
| `app/index.tsx`          | `/` (home)               |
| `app/about.tsx`          | `/about`                 |
| `app/[id].tsx`           | `/123`, `/abc` (dynamic) |
| `app/(tabs)/_layout.tsx` | Tab navigator            |
| `app/(tabs)/home.tsx`    | Tab: Home                |
| `app/_layout.tsx`        | Root layout              |

## Navigation

```tsx
import { Link, router } from "expo-router";

<Link href="/about">Go to About</Link>
<Link href={{ pathname: "/user/[id]", params: { id: "42" } }}>User</Link>

router.push("/about");
router.replace("/home");
router.back();
```

## Styling — React Native StyleSheet

Use `StyleSheet.create()` for all styling. Do NOT use HTML/CSS classes or Tailwind.

```tsx
import { StyleSheet, View, Text } from "react-native";

export default function Screen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hello</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  title: { fontSize: 24, fontWeight: "bold", color: "#333" },
});
```

## React Native components (NOT HTML)

- `<View>` not `<div>`
- `<Text>` not `<p>`, `<span>`, `<h1>` etc.
- `<TouchableOpacity>` or `<Pressable>` not `<button>`
- `<TextInput>` not `<input>`
- `<Image source={...}>` not `<img>` (import from react-native)
- `<ScrollView>` for scrollable content
- `<FlatList>` for long virtualized lists
- `<SafeAreaView>` to avoid notch/status bar overlap

## Adding native packages

For packages with native code (anything in the Expo ecosystem), use
`run_terminal_command` with `npx expo install` — this pins the version
that is compatible with the installed Expo SDK:

```
npx expo install @react-native-picker/picker
npx expo install expo-camera
npx expo install expo-location
npx expo install react-native-maps
```

For pure JavaScript packages (no native code), `add_dependency` works fine.

## Icons

```tsx
import { Ionicons } from "@expo/vector-icons";
<Ionicons name="home-outline" size={24} color="#6366f1" />;
```

## Data fetching

Use `useEffect` + `fetch`, or React Query. No Node.js modules (`fs`, `path`, etc.).

## Platform-specific code

```tsx
import { Platform } from "react-native";
if (Platform.OS === "android") {
  /* ... */
}
if (Platform.OS === "ios") {
  /* ... */
}
```

## CRITICAL RULES

1. NEVER use HTML tags (`div`, `span`, `button`, `input`) — use React Native components
2. NEVER use `className` prop — use `style={styles.xxx}` with StyleSheet
3. NEVER use `position: fixed` — use `SafeAreaView` and flex layout
4. NEVER use `window`, `document`, or browser-only APIs
5. ALWAYS wrap top-level screens in `<SafeAreaView style={{ flex: 1 }}>` or `<ScrollView>`
6. `flex: 1` is essential on containers — RN uses column-flex by default
7. For native packages (Expo ecosystem), install with `npx expo install <pkg>` via `run_terminal_command`
8. The `preview` script exports a static web build — it is not an Android/iOS preview
