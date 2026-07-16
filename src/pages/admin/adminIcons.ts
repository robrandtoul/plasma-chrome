import {
  BarChart3,
  Building2,
  PackageSearch,
  MapPin,
  Truck,
  AlertCircle,
  Sparkles,
  PenLine,
  Layers,
  PoundSterling,
  Table2,
  Users,
  Settings,
  ClipboardList,
  type LucideIcon,
} from 'lucide-react'

// Icon-key → lucide component, keyed by the `icon` string on each
// AdminDestination (src/lib/adminSearch.ts). Kept out of adminSearch.ts so that
// file stays pure/testable; shared by the sidebar (AdminLayout) and the search
// palette (AdminSearch) so both draw the same glyphs.
export const ADMIN_ICONS: Record<string, LucideIcon> = {
  analytics: BarChart3,
  customers: Building2,
  orders: PackageSearch,
  shipping: MapPin,
  outsourcing: Truck,
  followups: AlertCircle,
  ai: Sparkles,
  content: PenLine,
  materials: Layers,
  pricing: PoundSterling,
  catalogue: Table2,
  users: Users,
  settings: Settings,
  activity: ClipboardList,
}

export const ADMIN_FALLBACK_ICON: LucideIcon = Table2
