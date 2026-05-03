import type {
  MetaFunction,
  LoaderFunctionArgs,
  ActionFunctionArgs,
} from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";

export const meta: MetaFunction = () => [
  { title: "Remix App" },
  { name: "description", content: "Built with Remix + Tailwind CSS" },
];

// Loader — runs on the server, data available in useLoaderData()
export async function loader(_args: LoaderFunctionArgs) {
  return json({
    message: "Hello from the server!",
    timestamp: new Date().toISOString(),
  });
}

// Action — handles form POSTs; use Form component (no JS required)
export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "greet") {
    const name = formData.get("name") as string;
    return json({ greeting: `Hello, ${name || "world"}!` });
  }

  return json({ greeting: null });
}

export default function IndexRoute() {
  const { message, timestamp } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-lg w-full mx-auto px-4 space-y-8 text-center">
        <div>
          <h1 className="text-4xl font-bold text-gray-900">Remix App</h1>
          <p className="mt-2 text-gray-500">
            Edit{" "}
            <code className="bg-gray-100 px-1 rounded font-mono text-sm">
              app/routes/_index.tsx
            </code>{" "}
            to get started.
          </p>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl p-6 text-left space-y-2">
          <p className="text-sm text-gray-500 font-medium">
            From loader (server):
          </p>
          <p className="text-gray-800">{message}</p>
          <p className="text-xs text-gray-400 font-mono">{timestamp}</p>
        </div>

        <Form method="post" className="flex gap-2">
          <input
            name="name"
            placeholder="Your name…"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button
            type="submit"
            name="intent"
            value="greet"
            disabled={isSubmitting}
            className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? "Sending…" : "Greet"}
          </button>
        </Form>

        <p className="text-sm text-gray-400">Powered by Remix + Tailwind CSS</p>
      </div>
    </main>
  );
}
