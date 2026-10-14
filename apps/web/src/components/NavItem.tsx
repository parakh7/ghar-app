import type { ComponentType } from "react";
import { NavLink } from "react-router-dom";

export function NavItem({ to, label, icon: Icon, end }: {
  to: string; label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }>; end?: boolean;
}) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item${isActive ? " nav-item--active" : ""}`}>
      <Icon size={22} strokeWidth={2} />
      <span>{label}</span>
    </NavLink>
  );
}
