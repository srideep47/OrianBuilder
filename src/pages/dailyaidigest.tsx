import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Bell,
  X,
  Plus,
  Cloud,
  TrendingUp,
  TrendingDown,
  Flame,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Maximize2,
  Pencil,
  Settings,
  Wifi,
  WifiOff,
  Loader2,
  Newspaper,
  Cpu,
  Briefcase,
  Trophy,
  Film,
  FlaskConical,
  Globe2,
  MapPin,
  Sparkles,
  Headphones,
  Square,
  BookOpen,
  User,
  UserRound,
  CircleDollarSign,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { toast } from "sonner";

// Optional Python backend (Daily AI Digest repo) for AI summaries.
const DAILY_DIGEST_BACKEND_URL = "http://127.0.0.1:8010";

// CORS-friendly RSS → JSON service. Free public tier, no key required.
const RSS_TO_JSON = "https://api.rss2json.com/v1/api.json?rss_url=";

interface NewsStory {
  title: string;
  link?: string;
  source?: string;
  published?: string;
  summary?: string;
  image?: string;
}

interface CategoryDef {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  feeds: { url: string; source: string }[];
}

// --- News categories with public RSS feeds -----------------------------------

const CATEGORIES: CategoryDef[] = [
  {
    id: "top",
    label: "Top Stories",
    icon: Flame,
    feeds: [
      { url: "https://feeds.bbci.co.uk/news/rss.xml", source: "BBC" },
      { url: "https://www.theguardian.com/world/rss", source: "The Guardian" },
    ],
  },
  {
    id: "tech",
    label: "Technology",
    icon: Cpu,
    feeds: [
      { url: "https://techcrunch.com/feed/", source: "TechCrunch" },
      { url: "https://www.theverge.com/rss/index.xml", source: "The Verge" },
      {
        url: "https://feeds.bbci.co.uk/news/technology/rss.xml",
        source: "BBC Tech",
      },
    ],
  },
  {
    id: "business",
    label: "Business",
    icon: Briefcase,
    feeds: [
      {
        url: "https://feeds.bbci.co.uk/news/business/rss.xml",
        source: "BBC Business",
      },
      {
        url: "https://www.cnbc.com/id/10001147/device/rss/rss.html",
        source: "CNBC",
      },
    ],
  },
  {
    id: "sports",
    label: "Sports",
    icon: Trophy,
    feeds: [
      { url: "https://feeds.bbci.co.uk/sport/rss.xml", source: "BBC Sport" },
      { url: "https://www.espn.com/espn/rss/news", source: "ESPN" },
    ],
  },
  {
    id: "entertainment",
    label: "Entertainment",
    icon: Film,
    feeds: [
      {
        url: "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
        source: "BBC Arts",
      },
      { url: "https://variety.com/feed/", source: "Variety" },
    ],
  },
  {
    id: "science",
    label: "Science",
    icon: FlaskConical,
    feeds: [
      {
        url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
        source: "BBC Science",
      },
      {
        url: "https://www.wired.com/feed/category/science/latest/rss",
        source: "Wired",
      },
    ],
  },
  {
    id: "world",
    label: "World",
    icon: Globe2,
    feeds: [
      {
        url: "https://feeds.bbci.co.uk/news/world/rss.xml",
        source: "BBC World",
      },
      { url: "https://www.theguardian.com/world/rss", source: "The Guardian" },
    ],
  },
  {
    id: "india",
    label: "India",
    icon: MapPin,
    feeds: [
      {
        url: "https://www.thehindu.com/news/national/feeder/default.rss",
        source: "The Hindu",
      },
      {
        url: "https://feeds.feedburner.com/ndtvnews-india-news",
        source: "NDTV",
      },
    ],
  },
  {
    id: "ai",
    label: "AI",
    icon: Sparkles,
    feeds: [
      {
        url: "https://techcrunch.com/category/artificial-intelligence/feed/",
        source: "TechCrunch AI",
      },
      {
        url: "https://www.technologyreview.com/feed/",
        source: "MIT Tech Review",
      },
    ],
  },
];

// --- Mock data for widgets the backend doesn't provide -----------------------

interface MarketRow {
  symbol: string;
  label: string;
  change: number;
  value: string;
  trend: "up" | "down";
}

const MOCK_MARKETS: MarketRow[] = [
  {
    symbol: "NIFTY",
    label: "Rising fast",
    change: 1.24,
    value: "24,330.95",
    trend: "up",
  },
  {
    symbol: "SENSEX",
    label: "Rising fast",
    change: 1.22,
    value: "77,958.52",
    trend: "up",
  },
  {
    symbol: "Nifty Bank",
    label: "Rising fast",
    change: 2.63,
    value: "55,981.05",
    trend: "up",
  },
  {
    symbol: "Nifty MidCap",
    label: "Rising fast",
    change: 1.76,
    value: "61,326.70",
    trend: "up",
  },
  {
    symbol: "USD/INR",
    label: "US Dollar/Indian Rupee",
    change: -0.6,
    value: "94.61",
    trend: "down",
  },
];

// Realistic spot commodity prices in USD as of May 2026. INR values are
// computed live from these using the USD/INR rate fetched from frankfurter.app.
// These are "indicative" — true real-time prices would require a paid feed.
interface CommodityRef {
  symbol: string;
  unit: string;
  usd: number;
  change: number;
  trend: "up" | "down";
}

const COMMODITY_REFS: CommodityRef[] = [
  // Gold ~$6,000/oz × 0.3215 oz/10g ≈ $1,930
  {
    symbol: "Gold",
    unit: "per 10g, 24k",
    usd: 1932,
    change: 3.23,
    trend: "up",
  },
  // Silver ~$67/oz × 32.15 oz/kg ≈ $2,155
  { symbol: "Silver", unit: "per kg", usd: 2155, change: 6.12, trend: "up" },
  // WTI crude
  {
    symbol: "Crude Oil",
    unit: "per barrel (WTI)",
    usd: 80.05,
    change: -0.84,
    trend: "down",
  },
  // Henry Hub natural gas
  {
    symbol: "Natural Gas",
    unit: "per MMBtu",
    usd: 3.6,
    change: 1.18,
    trend: "up",
  },
];

function formatINR(amount: number): string {
  // Indian numbering: ₹1,62,450 (lakh/crore grouping)
  const rounded = Math.round(amount);
  const s = rounded.toString();
  if (s.length <= 3) return `₹${s}`;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `₹${grouped},${last3}`;
}

function formatUSD(amount: number): string {
  return amount >= 100
    ? `$${Math.round(amount).toLocaleString("en-US")}`
    : `$${amount.toFixed(2)}`;
}

const MOCK_WEATHER = {
  location: "Thimmapur",
  tempC: 33,
  forecast: "Expect 6 days with hot weather ahead starting Tomorrow.",
};

// --- Live sports via ESPN's free public API ----------------------------------
// (no API key needed, CORS-friendly, used internally by ESPN's site)

interface SportDef {
  id: string;
  label: string;
  url: string;
}

const SPORTS: SportDef[] = [
  {
    id: "cricket",
    label: "Cricket",
    // 8048 = IPL. Falls back gracefully if no event is live.
    url: "https://site.api.espn.com/apis/site/v2/sports/cricket/8048/scoreboard",
  },
  {
    id: "soccer",
    label: "Football",
    url: "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard",
  },
  {
    id: "nba",
    label: "NBA",
    url: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  },
  {
    id: "nfl",
    label: "NFL",
    url: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  },
  {
    id: "tennis",
    label: "Tennis",
    url: "https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard",
  },
  {
    id: "f1",
    label: "F1",
    url: "https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard",
  },
];

interface SportEvent {
  id: string;
  name: string;
  shortName: string;
  state: "pre" | "in" | "post";
  statusDetail: string;
  competitors: {
    name: string;
    abbreviation: string;
    score?: string;
    logo?: string;
    color?: string;
  }[];
  note?: string;
}

function normalizeESPN(raw: any): SportEvent[] {
  if (!raw?.events) return [];
  return raw.events.slice(0, 6).map((e: any): SportEvent => {
    const comp = e.competitions?.[0];
    const competitors = (comp?.competitors || []).map((c: any) => ({
      name: c.team?.displayName || c.athlete?.displayName || "TBD",
      abbreviation:
        c.team?.abbreviation ||
        c.athlete?.shortName ||
        (c.team?.displayName || "").slice(0, 3).toUpperCase(),
      score: c.score,
      logo: c.team?.logo,
      color: c.team?.color ? `#${c.team.color}` : undefined,
    }));
    return {
      id: e.id,
      name: e.name,
      shortName: e.shortName,
      state: e.status?.type?.state || "pre",
      statusDetail:
        e.status?.type?.shortDetail || e.status?.type?.description || "",
      competitors,
      note: comp?.notes?.[0]?.headline || comp?.situation?.lastPlay?.text,
    };
  });
}

const MOCK_NOTIFICATION = {
  source: "Breaking News",
  ago: "6h",
  text: "Welcome to your Daily AI Digest — pick a category above to load news.",
};

// -----------------------------------------------------------------------------

function getGreeting(date: Date): string {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function timeAgo(dateStr?: string): string | undefined {
  if (!dateStr) return undefined;
  const ts = Date.parse(dateStr);
  if (Number.isNaN(ts)) return undefined;
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function stripHtml(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstImage(html?: string): string | undefined {
  if (!html) return undefined;
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1];
}

// Upgrade common low-resolution thumbnail URLs to higher quality. Major outlets
// embed a size in the path or query string — bumping it gives much sharper
// images without breaking the URL.
function upgradeImage(url?: string): string | undefined {
  if (!url) return undefined;
  let u = url;
  // BBC ichef variants — they ship multiple URL shapes:
  //   /ace/standard/240/cpsprodpb/...   (newer)
  //   /news/ace/standard/240/...
  //   /news/240/cpsprodpb/...           (older)
  //   /ace/branded_news/240/...
  // Bump every size segment to 976 (their largest reliable preset).
  if (/ichef\.bbci\.co\.uk/.test(u)) {
    u = u.replace(
      /\/(ace\/standard|ace\/branded_news|news\/ace\/standard|news)\/\d{2,4}\//,
      "/$1/976/",
    );
  }
  // Guardian: /images/.../600.jpg → /1200.jpg
  u = u.replace(/(guim\.co\.uk\/.+?)\/(\d{3,4})\.(jpe?g|webp)/i, "$1/1200.$3");
  // The Verge / Vox: cdn.vox-cdn.com/thumbor/.../{N}x{M}/ → bump up
  u = u.replace(/(vox-cdn\.com\/thumbor\/[^/]+\/)\d+x\d+\//, "$11200x800/");
  // Generic ?w=, ?width=, &w= — upgrade to 1024 when smaller
  u = u.replace(/([?&])(w|width)=(\d+)/gi, (_, sep, key, n) => {
    const num = parseInt(n, 10);
    return `${sep}${key}=${Math.max(num, 1024)}`;
  });
  // Generic ?h=, ?height=, &h= — upgrade to 720 when smaller
  u = u.replace(/([?&])(h|height)=(\d+)/gi, (_, sep, key, n) => {
    const num = parseInt(n, 10);
    return `${sep}${key}=${Math.max(num, 720)}`;
  });
  return u;
}

async function fetchFeed(
  feedUrl: string,
  source: string,
): Promise<NewsStory[]> {
  const url = `${RSS_TO_JSON}${encodeURIComponent(feedUrl)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${feedUrl}`);
  const data = await res.json();
  if (data.status !== "ok" || !Array.isArray(data.items)) {
    throw new Error(`Bad RSS response for ${feedUrl}`);
  }
  return data.items.slice(0, 10).map((item: any): NewsStory => {
    const rawImage =
      item.enclosure?.link ||
      item.thumbnail ||
      extractFirstImage(item.content) ||
      extractFirstImage(item.description);
    return {
      title: item.title || "Untitled",
      link: item.link,
      source: item.author || data.feed?.title || source,
      published: timeAgo(item.pubDate) || item.pubDate,
      summary: stripHtml(item.description).slice(0, 600),
      image: upgradeImage(rawImage),
    };
  });
}

async function fetchCategory(cat: CategoryDef): Promise<NewsStory[]> {
  const results = await Promise.allSettled(
    cat.feeds.map((f) => fetchFeed(f.url, f.source)),
  );
  const merged: NewsStory[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const item of r.value) {
        const key = item.title.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(item);
        }
      }
    }
  }
  return merged;
}

export default function DailyAIDigestPage() {
  const [now, setNow] = useState(new Date());
  const [showSettings, setShowSettings] = useState(false);
  const [showNotification, setShowNotification] = useState(true);
  const [heroIndex, setHeroIndex] = useState(0);

  const [activeCategoryId, setActiveCategoryId] = useState<string>("top");
  const [stories, setStories] = useState<NewsStory[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [feedStatus, setFeedStatus] = useState<"live" | "loading" | "failed">(
    "loading",
  );

  // Reader pane state
  const [selectedStory, setSelectedStory] = useState<NewsStory | null>(null);

  // Optional AI backend
  const [serverUrl, setServerUrl] = useState(DAILY_DIGEST_BACKEND_URL);
  const [backendStatus, setBackendStatus] = useState<
    "checking" | "online" | "offline"
  >("checking");

  // Live USD→INR rate for commodity conversion. Falls back to a baseline if
  // the FX API is unreachable.
  const [usdToInr, setUsdToInr] = useState<number>(95.97);
  const [fxUpdatedAt, setFxUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Fetch live USD/INR exchange rate (free, CORS-friendly, no key required)
  useEffect(() => {
    let cancelled = false;
    const fetchRate = async () => {
      try {
        const r = await fetch(
          "https://api.frankfurter.app/latest?from=USD&to=INR",
        );
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled && typeof data?.rates?.INR === "number") {
          setUsdToInr(data.rates.INR);
          setFxUpdatedAt(new Date());
        }
      } catch {
        // Silent: keep the fallback rate
      }
    };
    fetchRate();
    const interval = setInterval(fetchRate, 30 * 60_000); // every 30 min
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const activeCategory =
    CATEGORIES.find((c) => c.id === activeCategoryId) || CATEGORIES[0];

  const loadCategory = async (cat: CategoryDef) => {
    setIsLoading(true);
    setFeedStatus("loading");
    setHeroIndex(0);
    setSelectedStory(null);
    try {
      const items = await fetchCategory(cat);
      if (items.length === 0) {
        setFeedStatus("failed");
        toast.error(`Couldn't load ${cat.label}. Try another category.`);
      } else {
        setStories(items);
        setFeedStatus("live");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedStatus("failed");
      toast.error(`Feed error: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCategory(activeCategory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategoryId]);

  const checkBackendHealth = async () => {
    try {
      const response = await fetch(`${serverUrl}/toplights`, { method: "GET" });
      setBackendStatus(response.ok ? "online" : "offline");
    } catch {
      setBackendStatus("offline");
    }
  };

  useEffect(() => {
    checkBackendHealth();
    const interval = setInterval(checkBackendHealth, 60_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  const { heroStories, cardStories, topStories } = useMemo(() => {
    const withImages = stories.filter((s) => s.image);
    const withoutImages = stories.filter((s) => !s.image);
    const heroes = withImages.slice(0, 5);
    const cards = withImages.slice(5, 9);
    const tops = (withoutImages.length > 0 ? withoutImages : stories).slice(
      0,
      4,
    );
    return { heroStories: heroes, cardStories: cards, topStories: tops };
  }, [stories]);

  const nextHero = () =>
    setHeroIndex((i) => (i + 1) % Math.max(heroStories.length, 1));
  const prevHero = () =>
    setHeroIndex(
      (i) => (i - 1 + heroStories.length) % Math.max(heroStories.length, 1),
    );
  const currentHero = heroStories[heroIndex];

  const readerOpen = selectedStory !== null;

  return (
    <div className="h-full w-full overflow-y-auto bg-transparent px-4 py-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1600px]">
        {/* Header bar */}
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{formatDate(now)}</p>
            <h1 className="text-2xl font-semibold">{getGreeting(now)}</h1>
          </div>
          <div className="flex items-center gap-1">
            <div className="mr-2 flex items-center gap-2 rounded-3xl border px-2 py-1">
              {feedStatus === "live" ? (
                <>
                  <Wifi className="h-3.5 w-3.5 text-green-500" />
                  <span className="text-xs text-green-600">Live Feed</span>
                </>
              ) : feedStatus === "failed" ? (
                <>
                  <WifiOff className="h-3.5 w-3.5 text-red-500" />
                  <span className="text-xs text-red-600">Feed Error</span>
                </>
              ) : (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-yellow-500" />
                  <span className="text-xs text-yellow-600">Loading</span>
                </>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => loadCategory(activeCategory)}
              title="Refresh"
            >
              <RefreshCw
                className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
              />
            </Button>
            <Button variant="ghost" size="icon" title="Expand">
              <Maximize2 className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" title="Customize">
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Settings"
              onClick={() => setShowSettings((s) => !s)}
              className={showSettings ? "bg-accent" : ""}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Category pills */}
        <div className="mb-4 flex flex-wrap gap-2">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const active = cat.id === activeCategoryId;
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategoryId(cat.id)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {cat.label}
              </button>
            );
          })}
        </div>

        {showSettings && (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Backend Settings (optional)</CardTitle>
              <CardDescription>
                The dashboard works out-of-the-box using public RSS feeds. For
                AI summaries via the Summarize button, run the Daily AI Digest
                Python backend on the URL below (Media AI uses 8000, so this
                defaults to 8010).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8010"
                  className="flex-1"
                />
                <Button onClick={checkBackendHealth} variant="secondary">
                  Test Connection
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                AI backend status:{" "}
                <span
                  className={
                    backendStatus === "online"
                      ? "text-green-600"
                      : backendStatus === "offline"
                        ? "text-red-600"
                        : "text-yellow-600"
                  }
                >
                  {backendStatus}
                </span>
                . See{" "}
                <a
                  href="https://github.com/akashboddula2425-hub/Daily_ai_digest"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  the repo
                </a>{" "}
                for setup. Requires Python 3.10+ and Ollama with{" "}
                <code>qwen3.5:4b</code>.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Dashboard grid — layout shifts when reader is open */}
        <div
          className={`grid grid-cols-1 gap-4 ${
            readerOpen ? "lg:grid-cols-4" : "lg:grid-cols-3"
          }`}
        >
          {/* Left column: widgets */}
          <div className="space-y-4 lg:col-span-1">
            {showNotification && (
              <Card>
                <CardContent className="p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Bell className="h-4 w-4 text-amber-500" />1 Notification
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setShowNotification(false)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <Flame className="mr-1 inline h-3 w-3 text-rose-500" />
                    {MOCK_NOTIFICATION.source} · {MOCK_NOTIFICATION.ago}
                  </div>
                  <p className="mt-2 text-sm font-medium">
                    {MOCK_NOTIFICATION.text}
                  </p>
                </CardContent>
              </Card>
            )}

            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-medium text-muted-foreground">
                Widgets
              </h2>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <Card className="overflow-hidden bg-gradient-to-br from-sky-700 to-sky-900 text-white">
              <CardContent className="p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <Cloud className="h-4 w-4" />
                  {MOCK_WEATHER.location}
                </div>
                <div className="flex items-end justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Cloud className="h-10 w-10 text-sky-200" />
                    <div>
                      <div className="text-4xl font-bold leading-none">
                        {MOCK_WEATHER.tempC}
                        <span className="ml-1 align-top text-lg">°C</span>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-sky-100">
                    {MOCK_WEATHER.forecast}
                  </p>
                </div>
                <div className="mt-3 flex justify-center">
                  <button className="rounded-full bg-white/15 px-3 py-1 text-xs hover:bg-white/25">
                    See full forecast
                  </button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-3">
                <div className="mb-2 flex items-center justify-between px-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <TrendingUp className="h-4 w-4 text-emerald-500" />
                    Markets
                  </div>
                </div>
                <div className="divide-y">
                  {MOCK_MARKETS.map((m) => (
                    <div
                      key={m.symbol}
                      className="flex items-center justify-between px-1 py-2"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1 text-sm font-medium">
                          {m.symbol}
                          {m.trend === "up" ? (
                            <TrendingUp className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <TrendingDown className="h-3 w-3 text-rose-500" />
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.label}
                        </div>
                      </div>
                      <div className="text-right">
                        <div
                          className={`text-sm font-medium ${
                            m.trend === "up"
                              ? "text-emerald-500"
                              : "text-rose-500"
                          }`}
                        >
                          {m.change > 0 ? "+" : ""}
                          {m.change.toFixed(2)}%
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {m.value}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-3">
                <div className="mb-2 flex items-center justify-between px-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <CircleDollarSign className="h-4 w-4 text-amber-500" />
                    Commodities
                  </div>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    INR · USD
                  </span>
                </div>
                <div className="divide-y">
                  {COMMODITY_REFS.map((c) => {
                    const inr = formatINR(c.usd * usdToInr);
                    const usd = formatUSD(c.usd);
                    return (
                      <div
                        key={c.symbol}
                        className="flex items-center justify-between px-1 py-2"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1 text-sm font-medium">
                            {c.symbol}
                            {c.trend === "up" ? (
                              <TrendingUp className="h-3 w-3 text-emerald-500" />
                            ) : (
                              <TrendingDown className="h-3 w-3 text-rose-500" />
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {c.unit}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-medium">{inr}</div>
                          <div className="text-xs text-muted-foreground">
                            {usd}
                            <span
                              className={`ml-1.5 ${
                                c.trend === "up"
                                  ? "text-emerald-500"
                                  : "text-rose-500"
                              }`}
                            >
                              {c.change > 0 ? "+" : ""}
                              {c.change.toFixed(2)}%
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 px-1 text-[10px] text-muted-foreground">
                  ₹{usdToInr.toFixed(2)} per $1
                  {fxUpdatedAt &&
                    ` · FX live · ${fxUpdatedAt.toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`}
                  {" · prices indicative"}
                </p>
              </CardContent>
            </Card>

            <SportsWidget />
          </div>

          {/* Middle column: news */}
          <div
            className={`space-y-4 ${
              readerOpen ? "lg:col-span-1" : "lg:col-span-2"
            }`}
          >
            {isLoading && stories.length === 0 ? (
              <Card>
                <CardContent className="flex h-96 flex-col items-center justify-center gap-3 text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin" />
                  <p className="text-sm">Loading {activeCategory.label}…</p>
                </CardContent>
              </Card>
            ) : feedStatus === "failed" && stories.length === 0 ? (
              <Card>
                <CardContent className="flex h-96 flex-col items-center justify-center gap-3 text-muted-foreground">
                  <Newspaper className="h-8 w-8" />
                  <p className="text-sm">
                    Could not load any feeds for {activeCategory.label}.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => loadCategory(activeCategory)}
                  >
                    Retry
                  </Button>
                </CardContent>
              </Card>
            ) : readerOpen ? (
              // Compact list when reader is open — every story is a clickable row
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">
                    {activeCategory.label} headlines
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <ul className="max-h-[calc(100vh-260px)] divide-y overflow-y-auto">
                    {stories.map((story, i) => (
                      <li key={i}>
                        <button
                          onClick={() => setSelectedStory(story)}
                          className={`flex w-full gap-3 p-3 text-left hover:bg-accent ${
                            selectedStory?.title === story.title
                              ? "bg-accent"
                              : ""
                          }`}
                        >
                          <SafeImage
                            src={story.image}
                            alt=""
                            className="h-16 w-20 flex-shrink-0 rounded object-cover"
                            fallback={
                              <ImageFallback
                                source={story.source}
                                className="h-16 w-20 flex-shrink-0 rounded"
                              />
                            }
                          />
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-sm font-medium">
                              {story.title}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {story.source}
                              {story.published && ` · ${story.published}`}
                            </p>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ) : (
              <>
                {currentHero && (
                  <Card className="overflow-hidden">
                    <div className="relative">
                      <button
                        onClick={() => setSelectedStory(currentHero)}
                        className="block w-full text-left"
                      >
                        <SafeImage
                          src={currentHero.image}
                          alt={currentHero.title}
                          className="h-72 w-full object-cover sm:h-96"
                          fallback={
                            <ImageFallback
                              source={currentHero.source}
                              className="h-72 w-full sm:h-96"
                            />
                          }
                        />
                      </button>
                      {heroStories.length > 1 && (
                        <>
                          <button
                            onClick={prevHero}
                            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
                            aria-label="Previous"
                          >
                            <ChevronLeft className="h-5 w-5" />
                          </button>
                          <button
                            onClick={nextHero}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
                            aria-label="Next"
                          >
                            <ChevronRight className="h-5 w-5" />
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => setSelectedStory(currentHero)}
                        className="absolute inset-x-0 bottom-0 block w-full bg-gradient-to-t from-black/80 to-transparent p-4 text-left text-white"
                      >
                        <p className="text-xs opacity-80">
                          {currentHero.source}
                          {currentHero.published &&
                            ` · ${currentHero.published}`}
                        </p>
                        <h2 className="mt-1 line-clamp-2 text-xl font-semibold">
                          {currentHero.title}
                        </h2>
                      </button>
                      <div className="pointer-events-none absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
                        {heroStories.map((_, i) => (
                          <span
                            key={i}
                            className={`h-1.5 w-1.5 rounded-full ${
                              i === heroIndex ? "bg-white" : "bg-white/40"
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  </Card>
                )}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {cardStories.slice(0, 2).map((story, i) => (
                    <NewsCard
                      key={i}
                      story={story}
                      onClick={() => setSelectedStory(story)}
                    />
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Card>
                    <CardContent className="p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Flame className="h-4 w-4 text-rose-500" /> Top
                          stories
                        </div>
                      </div>
                      <ul className="space-y-3">
                        {topStories.map((s, i) => (
                          <li key={i} className="border-b pb-3 last:border-0">
                            <p className="text-xs text-muted-foreground">
                              {s.source}
                              {s.published && ` · ${s.published}`}
                            </p>
                            <button
                              onClick={() => setSelectedStory(s)}
                              className="mt-1 line-clamp-2 block text-left text-sm font-medium hover:underline"
                            >
                              {s.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>

                  {cardStories[2] && (
                    <NewsCard
                      story={cardStories[2]}
                      onClick={() => setSelectedStory(cardStories[2])}
                    />
                  )}
                </div>

                {cardStories[3] && (
                  <NewsCard
                    story={cardStories[3]}
                    fullWidth
                    onClick={() => setSelectedStory(cardStories[3])}
                  />
                )}
              </>
            )}
          </div>

          {/* Right column: reader pane */}
          {readerOpen && selectedStory && (
            <div className="lg:col-span-2">
              <ReaderPane
                story={selectedStory}
                onClose={() => setSelectedStory(null)}
                serverUrl={serverUrl}
                backendOnline={backendStatus === "online"}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------

function SportsWidget() {
  const [activeSportId, setActiveSportId] = useState<string>("cricket");
  const [events, setEvents] = useState<SportEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSport = async (sportId: string) => {
    const sport = SPORTS.find((s) => s.id === sportId);
    if (!sport) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(sport.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const normalized = normalizeESPN(data);
      // Live games first, then upcoming, then finished
      normalized.sort((a, b) => {
        const order = { in: 0, pre: 1, post: 2 } as const;
        return order[a.state] - order[b.state];
      });
      setEvents(normalized);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSport(activeSportId);
    // Refresh live scores every 60s
    const interval = setInterval(() => loadSport(activeSportId), 60_000);
    return () => clearInterval(interval);
  }, [activeSportId]);

  const liveCount = events.filter((e) => e.state === "in").length;

  return (
    <Card>
      <CardContent className="p-3">
        <div className="mb-2 flex items-center justify-between px-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Trophy className="h-4 w-4 text-amber-500" />
            Sports
          </div>
          {liveCount > 0 && (
            <span className="flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-500">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              {liveCount} LIVE
            </span>
          )}
        </div>
        {/* Sport pills */}
        <div className="mb-2 -mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {SPORTS.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSportId(s.id)}
              className={`flex-shrink-0 rounded-full border px-2.5 py-1 text-[11px] transition ${
                s.id === activeSportId
                  ? "border-primary bg-primary text-primary-foreground"
                  : "hover:bg-accent"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {loading && events.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading scores…
          </div>
        ) : error ? (
          <div className="py-3 text-center text-xs text-muted-foreground">
            Could not load scores. Will retry shortly.
          </div>
        ) : events.length === 0 ? (
          <div className="py-3 text-center text-xs text-muted-foreground">
            No fixtures right now.
          </div>
        ) : (
          <div className="space-y-2">
            {events.slice(0, 3).map((event) => (
              <SportEventCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SportEventCard({ event }: { event: SportEvent }) {
  const isLive = event.state === "in";
  const isFinished = event.state === "post";
  const [a, b] = event.competitors;
  if (!a || !b) {
    // Individual sports (tennis, F1) sometimes use a different shape
    return (
      <div className="rounded-3xl border p-2 text-xs">
        <div className="font-medium">{event.shortName || event.name}</div>
        <div className="mt-0.5 text-muted-foreground">{event.statusDetail}</div>
      </div>
    );
  }
  return (
    <div className="rounded-3xl border p-2">
      <div className="flex items-center justify-between gap-2">
        <CompetitorRow
          c={a}
          winner={isFinished && Number(a.score) > Number(b.score)}
        />
        {isLive ? (
          <span className="flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            LIVE
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">
            {event.statusDetail}
          </span>
        )}
        <CompetitorRow
          c={b}
          winner={isFinished && Number(b.score) > Number(a.score)}
          align="right"
        />
      </div>
      {event.note && (
        <p className="mt-1.5 line-clamp-1 text-[10px] text-muted-foreground">
          {event.note}
        </p>
      )}
    </div>
  );
}

function CompetitorRow({
  c,
  winner,
  align,
}: {
  c: SportEvent["competitors"][number];
  winner?: boolean;
  align?: "right";
}) {
  return (
    <div
      className={`flex flex-1 items-center gap-1.5 ${
        align === "right" ? "flex-row-reverse text-right" : ""
      }`}
    >
      {c.logo ? (
        <img
          src={c.logo}
          alt={c.abbreviation}
          className="h-6 w-6 flex-shrink-0 object-contain"
        />
      ) : (
        <div
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white"
          style={{ backgroundColor: c.color || "#475569" }}
        >
          {c.abbreviation.slice(0, 3)}
        </div>
      )}
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{c.abbreviation}</div>
        {c.score !== undefined && c.score !== "" && (
          <div
            className={`text-xs ${
              winner ? "font-bold text-emerald-500" : "text-muted-foreground"
            }`}
          >
            {c.score}
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function SafeImage({
  src,
  alt,
  className,
  fallback,
}: {
  src?: string;
  alt?: string;
  className?: string;
  fallback: React.ReactNode;
}) {
  const [errored, setErrored] = useState(false);
  if (!src || errored) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt || ""}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={className}
      onError={() => setErrored(true)}
    />
  );
}

function ImageFallback({
  source,
  className,
}: {
  source?: string;
  className?: string;
}) {
  const letter = (source?.[0] || "N").toUpperCase();
  return (
    <div
      className={`flex items-center justify-center bg-gradient-to-br from-slate-700 to-slate-900 ${
        className || ""
      }`}
    >
      <div className="flex flex-col items-center gap-1 text-slate-300">
        <Newspaper className="h-6 w-6" />
        <span className="text-xs font-medium">{letter}</span>
      </div>
    </div>
  );
}

function NewsCard({
  story,
  fullWidth,
  onClick,
}: {
  story: NewsStory;
  fullWidth?: boolean;
  onClick: () => void;
}) {
  const imgClass = `w-full object-cover ${fullWidth ? "h-72" : "h-44"}`;
  return (
    <Card
      onClick={onClick}
      className="cursor-pointer overflow-hidden transition hover:ring-1 hover:ring-primary/40"
    >
      <SafeImage
        src={story.image}
        alt={story.title}
        className={imgClass}
        fallback={<ImageFallback source={story.source} className={imgClass} />}
      />
      <CardContent className="p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {story.source}
          {story.published && ` · ${story.published}`}
        </div>
        <p className="mt-2 line-clamp-3 text-sm font-medium">{story.title}</p>
      </CardContent>
    </Card>
  );
}

// -----------------------------------------------------------------------------

// --- Voice helpers -----------------------------------------------------------

type Gender = "male" | "female";

const FEMALE_NAME_HINTS = [
  "zira",
  "samantha",
  "victoria",
  "kate",
  "serena",
  "allison",
  "susan",
  "karen",
  "moira",
  "tessa",
  "fiona",
  "veena",
  "rishi",
  "ava",
  "hazel",
  "linda",
  "heather",
  "catherine",
];
const MALE_NAME_HINTS = [
  "david",
  "mark",
  "george",
  "james",
  "daniel",
  "alex",
  "fred",
  "tom",
  "paul",
  "eddie",
  "guy",
  "ravi",
  "oliver",
  "aaron",
  "arthur",
];

function classifyVoice(v: SpeechSynthesisVoice): Gender | "unknown" {
  const n = v.name.toLowerCase();
  if (/(\bfemale\b|woman|girl)/.test(n)) return "female";
  if (/(\bmale\b|man\b|boy)/.test(n) && !n.includes("female")) return "male";
  if (FEMALE_NAME_HINTS.some((h) => n.includes(h))) return "female";
  if (MALE_NAME_HINTS.some((h) => n.includes(h))) return "male";
  return "unknown";
}

function pickVoice(
  voices: SpeechSynthesisVoice[],
  gender: Gender,
): SpeechSynthesisVoice | undefined {
  const englishFirst = voices.slice().sort((a, b) => {
    const ae = a.lang.toLowerCase().startsWith("en") ? -1 : 0;
    const be = b.lang.toLowerCase().startsWith("en") ? -1 : 0;
    return ae - be;
  });
  const match = englishFirst.find((v) => classifyVoice(v) === gender);
  if (match) return match;
  // Fallback: any voice — speech is still better than nothing
  return englishFirst[0];
}

// Common navigation labels emitted by news-site headers (BBC, Guardian, etc.).
const NAV_LABELS = new Set([
  "home",
  "news",
  "sport",
  "business",
  "innovation",
  "culture",
  "arts",
  "travel",
  "earth",
  "audio",
  "video",
  "live",
  "weather",
  "iplayer",
  "sounds",
  "bitesize",
  "cbeebies",
  "cbbc",
  "food",
  "in pictures",
  "newsletters",
  "podcasts",
  "newsround",
  "tech",
  "world",
  "uk",
  "us & canada",
  "asia",
  "africa",
  "europe",
  "middle east",
  "latin america",
  "australia",
  "war in ukraine",
  "us elections",
  "skip to content",
  "watch live",
  "subscribe",
  "sign in",
  "menu",
  "advertisement",
  "share",
  "save",
  "comments",
  "copy link",
  "reuters",
  "reuters logo",
  "follow",
]);

// BBC ships its "BBC News in your language" footer as a long list of language
// names (often paired with a native script). We strip these too.
const LANGUAGE_NAMES = new Set([
  "afaan oromoo",
  "amharic",
  "arabic",
  "azerbaijani",
  "bengali",
  "burmese",
  "chinese",
  "cymraeg",
  "dari",
  "english",
  "french",
  "gaelic",
  "gahuza",
  "gujarati",
  "hausa",
  "hindi",
  "igbo",
  "indonesia",
  "indonesian",
  "japanese",
  "kinyarwanda",
  "kirundi",
  "korean",
  "kyrgyz",
  "marathi",
  "naidheachdan",
  "nepali",
  "noticias para hispanoparlantes",
  "pashto",
  "persian",
  "pidgin",
  "polish",
  "polski",
  "portuguese",
  "portugues",
  "português",
  "punjabi",
  "russian",
  "scotland",
  "serbian",
  "sinhala",
  "somali",
  "spanish",
  "swahili",
  "tamil",
  "telugu",
  "thai",
  "tigrinya",
  "turkish",
  "ukrainian",
  "urdu",
  "uzbek",
  "vietnamese",
  "welsh",
  "yoruba",
  "akuko n'igbo",
  "naidheachdan",
]);

// Patterns that mark the END of the real article body. Everything from here on
// is footer junk (related links, "more from", language selector, app promo,
// copyright, etc.) and gets dropped.
const FOOTER_MARKERS: RegExp[] = [
  /^bbc news in your language/i,
  /^bbc in (your )?other languages/i,
  /^more from bbc/i,
  /^more on this story/i,
  /^related (stories|topics|content|internet links)/i,
  /^top stories/i,
  /^more to explore/i,
  /^sign up (for|to) (our|the) /i,
  /^get the latest from bbc/i,
  /^follow bbc news/i,
  /^download the bbc news app/i,
  /^©\s*\d{4}\s*bbc/i,
  /^copyright\s*©/i,
  /^bbc is not responsible/i,
  /^terms of use/i,
  /^the guardian view/i,
  /^most viewed/i,
  /^about (the )?bbc/i,
  /^about us$/i,
  /^contact us$/i,
  /^privacy policy/i,
  /^cookie/i,
  /^accessibility help/i,
  /^parental guidance/i,
  /^advertise with us$/i,
  /^terms (of|and) /i,
  /^do not share/i,
  /^why you can trust/i,
];

// Strip the Jina Reader header, drop footer junk, clean up nav lines.
// Returns clean markdown ready for ReactMarkdown.
function cleanJinaOutput(raw: string): string {
  if (!raw) return "";
  const marker = "Markdown Content:";
  const idx = raw.indexOf(marker);
  let body = idx >= 0 ? raw.slice(idx + marker.length) : raw;

  body = body
    // Strip image markdown entirely: ![alt](url)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // Collapse [text](url) to just text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Drop empty link references: [](url)
    .replace(/\[\]\([^)]*\)/g, "")
    // Drop bare URLs on their own line
    .replace(/^https?:\/\/\S+$/gm, "");

  const lines = body.split("\n");
  const cleaned: string[] = [];
  let inArticleBody = false;
  let consecutiveShort = 0; // run of short list-ish lines → footer signal
  let firstWordOf = (s: string) => s.split(/\s+/)[0].toLowerCase();

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, "");
    const t = line.trim();
    const tl = t.toLowerCase();

    // Hard footer marker — stop here, everything after is junk
    if (inArticleBody && FOOTER_MARKERS.some((re) => re.test(t))) break;

    // Drop pure-bullet leftover marks
    if (/^[*\-•]+$/.test(tl)) continue;
    // Drop known navigation labels
    if (NAV_LABELS.has(tl)) continue;
    if (NAV_LABELS.has(tl.replace(/[.!?:]+$/, ""))) continue;
    // Drop list-item nav links like "* News" / "- News"
    const stripped = tl.replace(/^[*\-•]\s*/, "");
    if (NAV_LABELS.has(stripped)) continue;
    // Drop language-name lines: "Hindi हिन्दी", "Polish PO POLSKU", or the
    // bare english name itself. Match by first word OR full lowercase string.
    if (
      LANGUAGE_NAMES.has(tl) ||
      LANGUAGE_NAMES.has(firstWordOf(t)) ||
      LANGUAGE_NAMES.has(stripped)
    ) {
      // Once we see one of these and we're in body, treat as footer onset
      if (inArticleBody) break;
      continue;
    }

    // Detect a run of short lines once in body — strong footer signal
    if (inArticleBody) {
      if (t.length > 0 && t.length < 60 && !/^#{1,6}\s/.test(t)) {
        consecutiveShort += 1;
        if (consecutiveShort >= 5) {
          // We've crossed into the footer — drop these 5 and stop
          cleaned.splice(-Math.min(consecutiveShort - 1, cleaned.length));
          break;
        }
      } else if (t.length >= 60 || /^#{1,6}\s/.test(t)) {
        consecutiveShort = 0;
      }
    }

    // Once we hit a real paragraph (>= 40 chars OR a heading), enter body
    if (!inArticleBody) {
      if (t.length >= 40 || /^#{1,6}\s+\S/.test(t)) {
        inArticleBody = true;
      } else {
        // Still in header — skip short stuff
        continue;
      }
    }
    cleaned.push(line);
  }

  return cleaned
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// -----------------------------------------------------------------------------

function ReaderPane({
  story,
  onClose,
  serverUrl,
  backendOnline,
}: {
  story: NewsStory;
  onClose: () => void;
  serverUrl: string;
  backendOnline: boolean;
}) {
  const [summary, setSummary] = useState<string>("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [articleText, setArticleText] = useState<string>("");
  const [isFetchingArticle, setIsFetchingArticle] = useState(false);
  const [articleError, setArticleError] = useState<string | null>(null);

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [gender, setGender] = useState<Gender>("female");

  const stopSpeaking = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  };

  // Reset state whenever the selected story changes
  useEffect(() => {
    setSummary("");
    setSummaryKind(null);
    setSummaryError(null);
    setArticleText("");
    setArticleError(null);
    stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story.title]);

  // Load available voices (some browsers populate asynchronously)
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const loadVoices = () => {
      const list = window.speechSynthesis.getVoices();
      if (list.length > 0) setVoices(list);
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // Auto-fetch ad-free article body via Jina Reader (works without any backend)
  useEffect(() => {
    if (!story.link) return;
    let cancelled = false;
    setIsFetchingArticle(true);
    setArticleError(null);

    const tryFetch = async () => {
      // 1) Prefer the optional Python backend if online
      if (backendOnline) {
        try {
          const r = await fetch(`${serverUrl}/fetch-article`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: story.link }),
          });
          if (r.ok) {
            const data = await r.json();
            const text = data.text || data.content || "";
            if (text && !cancelled) {
              setArticleText(text);
              return;
            }
          }
        } catch {
          // fall through to Jina
        }
      }
      // 2) Public CORS-friendly reader: Jina Reader returns clean markdown.
      // Many modern news sites (BBC, NYT, Guardian) are JS-rendered SPAs;
      // Jina's default direct engine only gets the SSR shell (title + nav
      // tags). Try the browser engine first, then fall back to direct.
      const fetchJina = async (engine: "browser" | "direct") => {
        const r = await fetch(`https://r.jina.ai/${story.link}`, {
          headers: {
            Accept: "text/plain",
            "X-Return-Format": "markdown",
            "X-Engine": engine,
          },
        });
        if (!r.ok) throw new Error(`Reader ${r.status}`);
        return cleanJinaOutput(await r.text());
      };

      // Heuristic: a real article body has multiple paragraphs of prose, not
      // just a heading and a handful of nav bullets. Anything short is a stub.
      const looksLikeStub = (md: string) => {
        const stripped = md
          .replace(/^#{1,6}\s.*$/gm, "")
          .replace(/^[*\-•]\s.*$/gm, "")
          .trim();
        return stripped.length < 300;
      };

      let lastErr: unknown = null;
      for (const engine of ["browser", "direct"] as const) {
        try {
          const text = await fetchJina(engine);
          if (cancelled) return;
          if (!looksLikeStub(text)) {
            setArticleText(text);
            return;
          }
          lastErr = new Error("stub response");
        } catch (err) {
          lastErr = err;
        }
      }
      if (!cancelled) {
        const msg =
          lastErr instanceof Error ? lastErr.message : String(lastErr);
        setArticleError(msg);
      }
    };

    tryFetch().finally(() => {
      if (!cancelled) setIsFetchingArticle(false);
    });

    return () => {
      cancelled = true;
    };
  }, [backendOnline, serverUrl, story.link]);

  // Client-side extractive summary used as fallback when the AI backend is
  // offline OR when its call fails. Splits the text into sentences and picks
  // the first 4 that are long enough to be meaningful.
  const extractiveSummary = (text: string): string => {
    if (!text) return "";
    const sentences = text
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 30);
    return sentences.slice(0, 4).join(" ");
  };

  const [summaryKind, setSummaryKind] = useState<"ai" | "auto" | null>(null);

  const handleSummarize = async () => {
    setSummaryError(null);
    setIsSummarizing(true);
    const sourceText = articleText || story.summary || story.title;
    const tryFallback = () => {
      const auto = extractiveSummary(sourceText) || sourceText.slice(0, 500);
      setSummary(auto || "Nothing to summarize yet.");
      setSummaryKind("auto");
    };
    try {
      if (!backendOnline) {
        tryFallback();
        return;
      }
      const res = await fetch(`${serverUrl}/summarize-article`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sourceText }),
      });
      if (!res.ok) {
        // Backend reachable but errored (e.g. Ollama down) — fall back silently
        tryFallback();
        return;
      }
      const data = await res.json();
      const aiSummary = data.summary || data.text || "";
      if (aiSummary.trim()) {
        setSummary(aiSummary);
        setSummaryKind("ai");
      } else {
        tryFallback();
      }
    } catch {
      tryFallback();
    } finally {
      setIsSummarizing(false);
    }
  };

  // Split text into ~200-char chunks at sentence boundaries so each utterance
  // stays well under Chrome's reliable TTS length. Long articles otherwise get
  // truncated silently after a few seconds of speech.
  const splitForSpeech = (text: string): string[] => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const sentences = clean.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/);
    const chunks: string[] = [];
    let buf = "";
    for (const s of sentences) {
      if ((buf + " " + s).trim().length > 200) {
        if (buf) chunks.push(buf.trim());
        if (s.length > 200) {
          // very long sentence — chop at word boundaries
          let rest = s;
          while (rest.length > 200) {
            const cut = rest.lastIndexOf(" ", 200);
            chunks.push(rest.slice(0, cut > 0 ? cut : 200).trim());
            rest = rest.slice(cut > 0 ? cut : 200);
          }
          buf = rest;
        } else {
          buf = s;
        }
      } else {
        buf = (buf ? buf + " " : "") + s;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
    return chunks;
  };

  const speak = (g: Gender) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      toast.error("Text-to-speech is not supported in this environment.");
      return;
    }
    if (isSpeaking) {
      stopSpeaking();
      return;
    }
    // Always read the full article when available; fall back progressively.
    const fullText = [story.title, summary, articleText || story.summary || ""]
      .filter(Boolean)
      .join(". ");
    if (!fullText.trim()) {
      toast.error("Nothing to read yet.");
      return;
    }
    const voice = pickVoice(voices, g);
    if (!voice) {
      toast.error("No speech voice available on this system.");
      return;
    }
    const chunks = splitForSpeech(fullText);
    if (chunks.length === 0) return;

    window.speechSynthesis.cancel();
    setIsSpeaking(true);
    chunks.forEach((chunk, i) => {
      const u = new SpeechSynthesisUtterance(chunk);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 1;
      u.pitch = g === "female" ? 1.05 : 0.95;
      if (i === chunks.length - 1) {
        u.onend = () => setIsSpeaking(false);
      }
      u.onerror = () => setIsSpeaking(false);
      window.speechSynthesis.speak(u);
    });
  };

  // Cleanup speech on unmount
  useEffect(() => {
    return () => stopSpeaking();
  }, []);

  const hasFemaleVoice = voices.some((v) => classifyVoice(v) === "female");
  const hasMaleVoice = voices.some((v) => classifyVoice(v) === "male");

  return (
    <Card className="sticky top-4">
      <CardContent className="p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">{story.title}</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onClose}
            title="Close reader"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {story.source}
          {story.published && ` · ${story.published}`}
        </p>

        {story.image && (
          <SafeImage
            src={story.image}
            alt=""
            className="mb-4 max-h-64 w-full rounded object-cover"
            fallback={<></>}
          />
        )}

        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            onClick={handleSummarize}
            disabled={isSummarizing}
            className="flex-1 min-w-[120px]"
          >
            {isSummarizing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            Summarize
          </Button>
        </div>

        {/* Listen controls with voice picker */}
        <div className="mb-4 rounded-3xl border p-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Headphones className="h-3.5 w-3.5" /> Listen with
            </span>
            {isSpeaking && (
              <Button
                onClick={stopSpeaking}
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-rose-500"
              >
                <Square className="mr-1 h-3.5 w-3.5" /> Stop
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                setGender("female");
                speak("female");
              }}
              disabled={!hasFemaleVoice && voices.length > 0}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-3xl border px-3 py-2 text-sm transition disabled:opacity-50 ${
                gender === "female" && isSpeaking
                  ? "border-pink-500 bg-pink-500/15 text-pink-500"
                  : "hover:bg-accent"
              }`}
              title={
                hasFemaleVoice
                  ? "Read with a female voice"
                  : "No female voice installed on this system"
              }
            >
              <UserRound className="h-4 w-4" />
              Female
            </button>
            <button
              onClick={() => {
                setGender("male");
                speak("male");
              }}
              disabled={!hasMaleVoice && voices.length > 0}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-3xl border px-3 py-2 text-sm transition disabled:opacity-50 ${
                gender === "male" && isSpeaking
                  ? "border-sky-500 bg-sky-500/15 text-sky-500"
                  : "hover:bg-accent"
              }`}
              title={
                hasMaleVoice
                  ? "Read with a male voice"
                  : "No male voice installed on this system"
              }
            >
              <User className="h-4 w-4" />
              Male
            </button>
          </div>
          {voices.length > 0 && !hasMaleVoice && !hasFemaleVoice && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              No gendered voices detected — using the system default.
            </p>
          )}
        </div>

        {summaryError && (
          <div className="mb-3 rounded-3xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-500">
            {summaryError}
          </div>
        )}

        {summary && (
          <div className="mb-4 rounded-3xl border bg-muted/40 p-3">
            <div className="mb-1 flex items-center gap-2">
              <p className="text-xs font-semibold text-muted-foreground">
                {summaryKind === "ai" ? "AI Summary" : "Quick Summary"}
              </p>
              {summaryKind === "auto" && (
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-500">
                  Offline
                </span>
              )}
              {summaryKind === "ai" && (
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-500">
                  AI
                </span>
              )}
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {summary}
            </p>
          </div>
        )}

        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <BookOpen className="h-3.5 w-3.5" /> Article
        </div>
        <div className="max-h-[55vh] overflow-y-auto rounded-3xl border p-4">
          {isFetchingArticle && !articleText ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading clean article view (ad-free)…
            </div>
          ) : articleText ? (
            <div
              className="prose prose-sm dark:prose-invert max-w-none
                prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2
                prose-h1:text-xl prose-h2:text-lg prose-h3:text-base
                prose-p:my-2 prose-p:leading-relaxed
                prose-a:text-sky-500 prose-a:no-underline hover:prose-a:underline
                prose-strong:text-foreground
                prose-ul:my-2 prose-li:my-1
                prose-img:hidden"
            >
              <ReactMarkdown>{articleText}</ReactMarkdown>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-muted-foreground">
                {story.summary ||
                  (articleError
                    ? `Could not load the full article in-app (${articleError}).`
                    : "No preview available.")}
              </p>
              {story.link && (
                <a
                  href={story.link}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 text-xs text-sky-500 hover:underline"
                >
                  Open original article →
                </a>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
