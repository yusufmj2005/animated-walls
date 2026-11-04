import { Badge, Card, PageHeader, SearchField, SectionTitle, StoreIcon } from '@animated-walls/design-system';

const PLACEHOLDER_CATEGORIES = ['Abstract', 'Nature', 'Sci-fi', 'Minimal', 'Anime', 'Interactive'];

// Labelled samples only. There are no real listings, creators, prices or purchases here.
const PLACEHOLDER_LISTINGS = [
  { gradient: 'linear-gradient(140deg,#1b2a55,#4764c4 60%,#a7b9ff)' },
  { gradient: 'linear-gradient(140deg,#231433,#6a2f7d 60%,#d27bb6)' },
  { gradient: 'linear-gradient(140deg,#0f2a24,#1f6d58 60%,#83d6ae)' },
  { gradient: 'linear-gradient(140deg,#2c1a12,#94502a 60%,#f0b27a)' },
  { gradient: 'linear-gradient(140deg,#121a2c,#2a4a6b 60%,#7fb4d6)' },
  { gradient: 'linear-gradient(140deg,#24121a,#7c2c44 60%,#ec8ba0)' },
  { gradient: 'linear-gradient(140deg,#16201a,#3e6a3a 60%,#a7cf85)' },
  { gradient: 'linear-gradient(140deg,#191925,#44446e 60%,#a3a3d8)' },
];

export function MarketplacePage() {
  return (
    <div className="mx-auto max-w-6xl animate-page px-8 py-7">
      <PageHeader title="Marketplace" description="Discover wallpapers from creators." actions={<Badge tone="warn">Preview</Badge>} />

      <Card className="mb-6 flex items-start gap-3 p-4" >
        <span className="mt-0.5 text-ink-2">
          <StoreIcon />
        </span>
        <div className="text-[13.5px]" data-testid="marketplace-notice">
          <div className="font-medium text-ink">The marketplace isn't open yet</div>
          <div className="mt-0.5 text-ink-2">This page shows the planned layout using placeholder artwork. Nothing here can be browsed, downloaded or bought, and no account is needed.</div>
        </div>
      </Card>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <SearchField placeholder="Search will be available when the marketplace opens" disabled className="w-96 opacity-60" aria-label="Search marketplace (not available yet)" />
        {PLACEHOLDER_CATEGORIES.map((category) => (
          <Badge key={category} className="h-7 px-3">
            {category}
          </Badge>
        ))}
      </div>

      <SectionTitle aside={<Badge tone="warn">Placeholder</Badge>}>Trending</SectionTitle>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
        {PLACEHOLDER_LISTINGS.map((listing, index) => (
          <div key={index} className="overflow-hidden rounded-card border border-line bg-surface" aria-label="Placeholder listing">
            <div className="preview-frame" style={{ backgroundImage: listing.gradient }} />
            <div className="px-3 py-2.5">
              <div className="text-[13.5px] font-medium text-ink-2">Sample listing</div>
              <div className="text-xs text-ink-3">Placeholder, not for sale</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
