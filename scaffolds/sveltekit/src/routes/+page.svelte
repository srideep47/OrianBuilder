<script lang="ts">
  let count = $state(0);
</script>

<main class="min-h-screen bg-gray-50 flex items-center justify-center">
  <div class="text-center space-y-6">
    <h1 class="text-4xl font-bold text-gray-900">SvelteKit App</h1>
    <p class="text-gray-500 text-lg">Edit <code class="bg-gray-100 px-2 py-0.5 rounded font-mono">src/routes/+page.svelte</code> to get started.</p>
    <div class="flex flex-col items-center gap-3">
      <button
        onclick={() => count++}
        class="px-6 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors font-medium"
      >
        Count: {count}
      </button>
      <p class="text-sm text-gray-400">Powered by SvelteKit + Tailwind CSS</p>
    </div>
  </div>
</main>
