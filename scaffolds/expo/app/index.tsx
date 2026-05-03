import { View, Text, TouchableOpacity, ScrollView } from "react-native";
import { useState } from "react";

export default function HomeScreen() {
  const [count, setCount] = useState(0);

  return (
    <ScrollView className="flex-1 bg-white dark:bg-gray-900">
      <View className="flex-1 items-center justify-center px-6 py-12 gap-6">
        {/* Hero */}
        <View className="items-center gap-2">
          <Text className="text-4xl font-bold text-indigo-500">Welcome</Text>
          <Text className="text-base text-gray-500 dark:text-gray-400 text-center">
            Your Expo + NativeWind app is ready.{"\n"}Edit{" "}
            <Text className="font-mono text-sm bg-gray-100 dark:bg-gray-800 px-1 rounded">
              app/index.tsx
            </Text>{" "}
            to get started.
          </Text>
        </View>

        {/* Counter demo */}
        <View className="items-center gap-4 bg-indigo-50 dark:bg-indigo-950 rounded-2xl p-8 w-full">
          <Text className="text-6xl font-bold text-indigo-600 dark:text-indigo-400">
            {count}
          </Text>
          <View className="flex-row gap-3">
            <TouchableOpacity
              onPress={() => setCount((c) => c - 1)}
              className="bg-gray-200 dark:bg-gray-700 rounded-xl px-6 py-3"
            >
              <Text className="text-lg font-semibold text-gray-700 dark:text-gray-200">
                −
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setCount((c) => c + 1)}
              className="bg-indigo-500 rounded-xl px-6 py-3"
            >
              <Text className="text-lg font-semibold text-white">+</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={() => setCount(0)}>
            <Text className="text-sm text-gray-400 dark:text-gray-500">
              Reset
            </Text>
          </TouchableOpacity>
        </View>

        {/* Info cards */}
        <View className="w-full gap-3">
          {[
            {
              emoji: "📱",
              title: "Expo Go",
              body: "Scan the QR code in OrianBuilder to preview on your device",
            },
            {
              emoji: "🌐",
              title: "Web",
              body: 'Run "npm run web" to open in the browser via expo-router',
            },
            {
              emoji: "🎨",
              title: "NativeWind",
              body: "Use Tailwind classes directly on native components",
            },
          ].map((card) => (
            <View
              key={card.title}
              className="flex-row items-start gap-3 bg-gray-50 dark:bg-gray-800 rounded-xl p-4"
            >
              <Text className="text-2xl">{card.emoji}</Text>
              <View className="flex-1">
                <Text className="font-semibold text-gray-800 dark:text-gray-100">
                  {card.title}
                </Text>
                <Text className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                  {card.body}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}
