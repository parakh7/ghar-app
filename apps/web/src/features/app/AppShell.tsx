import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import {
  Bell, ChartNoAxesColumn, ChevronDown, ClipboardCheck, Home, MoreHorizontal,
  PanelLeft, PanelLeftClose, ReceiptIndianRupee, Search, Settings, UserRound, Users, Wallet,
} from "lucide-react";
import { Logo } from "../../components/Logo";
import { NavItem } from "../../components/NavItem";
import { initials } from "../../lib/format";
import { useSession } from "../auth/session";
import { NotificationBadge } from "../notifications/NotificationBadge";
import { useUnreadCount } from "../notifications/useNotifications";
import { SearchInput } from "../search/SearchInput";
import { useActiveHousehold } from "./useActiveHousehold";
import "./shell.css";

const MAIN_NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/househelps", label: "Househelps", icon: Users, end: false },
  { to: "/checklist", label: "Checklist", icon: ClipboardCheck, end: false },
  { to: "/bills", label: "Bills", icon: ReceiptIndianRupee, end: false },
  { to: "/salary", label: "Salaries", icon: Wallet, end: false },
] as const;

const MORE_NAV = [
  { to: "/reports", label: "Reports", icon: ChartNoAxesColumn },
  { to: "/members", label: "Family members", icon: UserRound },
  { to: "/settings/notifications", label: "Settings", icon: Settings },
] as const;

const MOBILE_NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/househelps", label: "Househelps", icon: Users, end: false },
  { to: "/checklist", label: "Checklist", icon: ClipboardCheck, end: false },
  { to: "/bills", label: "Bills", icon: ReceiptIndianRupee, end: false },
  { to: "/more", label: "More", icon: MoreHorizontal, end: false },
] as const;

/** Shared between the mobile top bar (compact) and the desktop sidebar (labelled). */
function HouseholdSwitcher({ compact }: { compact?: boolean }) {
  const { household, households, switchTo } = useActiveHousehold();
  const [open, setOpen] = useState(false);
  if (!household) return null;
  return (
    <div className="shell__switcher">
      <button type="button" className="shell__switcher-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true">
        {!compact && <span className="shell__switcher-label">Household</span>}
        <span className="shell__switcher-name" title={household.name}>{household.name}</span>
        <ChevronDown size={16} aria-hidden strokeWidth={2} />
      </button>
      {open && (
        <div className="shell__switcher-panel" role="menu" aria-label="Switch household" onClick={() => setOpen(false)}>
          {households.map((h) => (
            <button key={h.id} type="button" role="menuitem" className="shell__switcher-item" aria-current={h.id === household.id || undefined} onClick={() => switchTo(h.id)}>
              {h.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const { data } = useSession();
  const { household } = useActiveHousehold();
  const unreadCount = useUnreadCount(household?.id).data ?? 0;
  const [collapsed, setCollapsed] = useState(false);
  const name = data?.user.name ?? "";

  return (
    <div className={`shell${collapsed ? " shell--collapsed" : ""}`}>
      <a href="#main" className="skip-link">Skip to content</a>

      <header className="shell__topbar">
        <HouseholdSwitcher compact />
        <div className="shell__topbar-actions">
          <NavLink to="/notifications" className="shell__bell" aria-label="Notifications">
            <Bell size={22} aria-hidden strokeWidth={2} />
            <NotificationBadge count={unreadCount} />
          </NavLink>
          <Link to="/more" className="shell__avatar" aria-label="View profile">{initials(name)}</Link>
        </div>
      </header>
      <NavLink to="/search" className="shell__mobile-search" aria-label="Open search">
        <Search size={20} aria-hidden strokeWidth={2} />
      </NavLink>

      <nav className="shell__sidebar" aria-label="Sidebar">
        <div className="shell__sidebar-head">
          <Logo size={32} />
          <p className="shell__app">Ghar</p>
          <button
            type="button" className="shell__collapse" onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeft size={20} aria-hidden strokeWidth={2} /> : <PanelLeftClose size={20} aria-hidden strokeWidth={2} />}
          </button>
        </div>
        <HouseholdSwitcher />
        <SearchInput />
        <p className="shell__group-label">Main</p>
        <ul className="shell__group">
          {MAIN_NAV.map(({ to, label, icon, end }) => (
            <li key={to}><NavItem to={to} label={label} icon={icon} end={end} /></li>
          ))}
        </ul>
        <p className="shell__group-label">More</p>
        <ul className="shell__group">
          {MORE_NAV.map(({ to, label, icon }) => (
            <li key={to}><NavItem to={to} label={label} icon={icon} /></li>
          ))}
        </ul>
        <Link to="/more" className="shell__profile" aria-label="View profile">
          <span className="shell__avatar" aria-hidden>{initials(name)}</span>
          <span className="shell__profile-text">
            <span className="shell__profile-name">{name}</span>
            <span className="shell__profile-link">View profile</span>
          </span>
        </Link>
      </nav>

      <nav className="shell__bottom-nav" aria-label="Main">
        <ul>
          {MOBILE_NAV.map(({ to, label, icon: Icon, end }) => (
            <li key={to}>
              <NavLink to={to} end={end} className="shell__link">
                <Icon size={24} aria-hidden strokeWidth={2} />
                <span>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <main id="main" className="shell__main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
