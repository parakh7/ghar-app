import {
  Building,
  CreditCard,
  Droplet,
  Flame,
  GraduationCap,
  Home,
  Landmark,
  Newspaper,
  Receipt,
  Shield,
  Smartphone,
  Tv,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-react";

/**
 * Maps the lucide-react icon slugs used by DEFAULT_BILL_CATEGORIES
 * (apps/api/src/services/household.service.ts) to their icon components.
 * User-created categories may set `icon` to an emoji or any other string;
 * unrecognized values should be rendered as literal text instead.
 */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  zap: Zap,
  wifi: Wifi,
  smartphone: Smartphone,
  "credit-card": CreditCard,
  "graduation-cap": GraduationCap,
  flame: Flame,
  droplet: Droplet,
  building: Building,
  home: Home,
  shield: Shield,
  tv: Tv,
  newspaper: Newspaper,
  landmark: Landmark,
  receipt: Receipt,
};
