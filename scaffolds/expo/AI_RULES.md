# AI Rules — Expo + NativeWind

## Project overview

- **Runtime**: React Native (Expo SDK 53) + expo-router v4
- **Styling**: NativeWind v4 (Tailwind CSS utility classes on native components)
- **Language**: TypeScript (strict)
- **Navigation**: expo-router (file-based, like Next.js but for native)

## Expo Router — file-based routing

| File                       | Route                          |
| -------------------------- | ------------------------------ |
| `app/index.tsx`            | `/` (home)                     |
| `app/about.tsx`            | `/about`                       |
| `app/[id].tsx`             | `/123`, `/abc` (dynamic)       |
| `app/(tabs)/_layout.tsx`   | Tab navigator                  |
| `app/(tabs)/home.tsx`      | Tab: Home                      |
| `app/_layout.tsx`          | Root layout (wraps all routes) |
| `app/(modal)/settings.tsx` | Modal route                    |

## Navigation

```tsx
import { Link, router } from "expo-router";

// Declarative link
<Link href="/about">Go to About</Link>
<Link href={{ pathname: "/user/[id]", params: { id: "42" } }}>User</Link>

// Imperative
router.push("/about");
router.replace("/home");
router.back();
```

## NativeWind (Tailwind on Native)

- Use Tailwind classes on ALL React Native core components
- Classes work on `View`, `Text`, `TouchableOpacity`, `ScrollView`, etc.
- Use `className` prop (NOT `style` for layout when Tailwind covers it)
- Dark mode: `dark:bg-gray-900`, `dark:text-white` etc.

```tsx
// CORRECT
<View className="flex-1 bg-white items-center justify-center p-4">
  <Text className="text-2xl font-bold text-gray-800 dark:text-white">Hello</Text>
</View>

// WRONG — web-only CSS
<div style={{ display: "flex" }}>

// WRONG — CSS properties not in NativeWind
<View className="grid grid-cols-3">  // grid not supported on native
```

## React Native components (NOT HTML)

- `<View>` not `<div>`
- `<Text>` not `<p>`, `<span>`, `<h1>`, etc.
- `<TouchableOpacity>` or `<Pressable>` not `<button>`
- `<TextInput>` not `<input>`
- `<Image>` not `<img>` (import from react-native)
- `<ScrollView>` not `<div style={{ overflow: "scroll" }}>`
- `<FlatList>` for long lists (virtualized)
- `<SafeAreaView>` for screens that need to avoid notches

## Layouts

```tsx
// Tabs
import { Tabs } from "expo-router";
export default function TabLayout() {
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: ... }} />
      <Tabs.Screen name="profile" options={{ title: "Profile" }} />
    </Tabs>
  );
}

// Stack with options
import { Stack } from "expo-router";
export default function StackLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

## Screen options (header, modal, etc.)

```tsx
import { useNavigation } from "expo-router";
import { useLayoutEffect } from "react";

export default function Screen() {
  const nav = useNavigation();
  useLayoutEffect(() => {
    nav.setOptions({ title: "My Title", headerRight: () => <Button /> });
  }, [nav]);
  return <View />;
}
```

## Icons

```tsx
import { Ionicons } from "@expo/vector-icons";
<Ionicons name="home-outline" size={24} color="#6366f1" />;
```

## Data fetching

- Use `useEffect` + `fetch` or `axios` (no server-only modules)
- React Query works fine: `useQuery`, `useMutation`
- No `fs`, `path`, or other Node.js modules — it's a mobile runtime

## Images

```tsx
import { Image } from "react-native";
<Image source={require("./assets/logo.png")} className="w-24 h-24" />
// or remote:
<Image source={{ uri: "https://..." }} className="w-24 h-24 rounded-full" />
```

## Platform-specific code

```tsx
import { Platform } from "react-native";
const isIOS = Platform.OS === "ios";
// or:
import { Platform } from "react-native";
const styles = Platform.select({
  ios: "bg-blue-500",
  android: "bg-green-500",
  default: "bg-gray-500",
});
```

## CRITICAL RULES

1. NEVER use HTML tags (`div`, `span`, `button`, `input`) — use React Native components
2. NEVER use `position: fixed` — use `SafeAreaView` and flex layout
3. NEVER use `window`, `document`, or browser APIs — check `Platform.OS` first
4. ALWAYS wrap top-level screens in `<SafeAreaView className="flex-1">` or `<ScrollView>`
5. NativeWind `flex-1` is essential on containers — RN defaults to `flexDirection: "column"` already
6. Expo Router `<Link>` must navigate to file-based routes, not arbitrary URLs
7. Use `npx expo start` to start the dev server and scan the QR code with Expo Go
