import { NavLink, Outlet } from "react-router-dom";
import { ClipboardCheck, Home, MoreHorizontal, ReceiptIndianRupee, Users } from "lucide-react";
import { Logo } from "../../components/Logo";
import { useActiveHousehold } from "./useActiveHousehold";
import "./shell.css";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/househelps", label: "Househelps", icon: Users },
  { to: "/checklist", label: "Checklist", icon: ClipboardCheck },
  { to: "/bills", label: "Bills", icon: ReceiptIndianRupee },
  { to: "/more", label: "More", icon: MoreHorizontal },
];

export function AppShell() {
  const { household } = useActiveHousehold();
  return (
    <div className="shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <nav className="shell__nav" aria-label="Main">
        <div className="shell__brand">
          <Logo size={32} />
          <div>
            <p className="shell__app">Ghar</p>
            {household && <p className="shell__household">{household.name}</p>}
          </div>
        </div>
        <ul>
          {NAV.map(({ to, label, icon: Icon, end }) => (
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
