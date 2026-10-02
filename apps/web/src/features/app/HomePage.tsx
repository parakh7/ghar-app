import { ClipboardCheck, ReceiptIndianRupee, Users, Wallet } from "lucide-react";
import { Link } from "react-router-dom";
import { formatINR } from "@household/shared";
import { useSession } from "../auth/session";
import { greeting, longDate } from "../../lib/format";
import { EmptyState } from "../../components/EmptyState";
import { VerifyEmailBanner } from "./VerifyEmailBanner";
import { useHousehold } from "./members/useMembers";
import { STATUS_LABEL, toneOf } from "./salary/statusTone";
import { useUpcomingSettlement } from "./salary/useSalary";
import { useActiveHousehold } from "./useActiveHousehold";

/** "2026-10-01" -> "October 2026". */
function monthLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * Phase 1: real greeting + household-local date. The "Today" sections are driven by
 * the TodayService (Phase 8); until their data exists they show honest empty states.
 */
export function HomePage() {
  const { data } = useSession();
  const { household } = useActiveHousehold();
  const householdQuery = useHousehold(household?.id);
  const canViewSalaries = householdQuery.data?.permissions.includes("salaries.view") ?? false;
  const { isLoading: salariesLoading, hasAnySettlement, upcoming } = useUpcomingSettlement(household?.id, canViewSalaries);
  const tz = household?.timezone ?? "Asia/Kolkata";
  const now = new Date();
  const [weekday, ...rest] = longDate(now, tz).split(" ");
  const firstName = data?.user.name.split(/\s+/)[0];

  return (
    <>
      <VerifyEmailBanner />
      <header className="today">
        <p className="today__greet">{greeting(now, tz)}{firstName ? `, ${firstName}` : ""}</p>
        <h1 className="today__date"><mark>{weekday?.replace(",", "")}</mark>,<br />{rest.join(" ")}</h1>
        <p className="today__stamp"><span className="today__dot" aria-hidden />Today at {household?.name}</p>
      </header>
      <div className="home-grid">
        <section className="card card--enter" style={{ animationDelay: "0ms" }} aria-labelledby="h-help">
          <h2 className="card__title" id="h-help">Househelp</h2>
          <EmptyState icon={<Users size={22} />} title="No househelps yet" text="Add the people who help at home to track who's coming each day." tone="coral" />
        </section>
        <section className="card card--enter" style={{ animationDelay: "70ms" }} aria-labelledby="h-work">
          <h2 className="card__title" id="h-work">Today's work</h2>
          <EmptyState icon={<ClipboardCheck size={22} />} title="No tasks for today" text="Create a checklist — daily dusting, Saturday bathrooms — and tick things off as they're done." tone="amber" />
        </section>
        <section className="card card--enter" style={{ animationDelay: "140ms" }} aria-labelledby="h-pay">
          <h2 className="card__title" id="h-pay">Payments</h2>
          <EmptyState icon={<ReceiptIndianRupee size={22} />} title="No bills tracked" text="Keep track of electricity, WiFi, maintenance and more. We'll remind you before they're due." tone="dusk" />
        </section>
        <section className="card card--enter" style={{ animationDelay: "210ms" }} aria-labelledby="h-sal">
          <h2 className="card__title" id="h-sal">Salaries</h2>
          {upcoming ? (
            <div className="list">
              <Link to={`/salary/${upcoming.settlement.id}`} className="list__item">
                <span className="list__text">
                  <span className="list__label" style={{ display: "block" }}>{upcoming.househelpName} · {monthLabel(upcoming.settlement.periodMonth)}</span>
                  <span className="list__meta">{formatINR(upcoming.settlement.netPayablePaise - upcoming.settlement.amountPaidPaise)} due</span>
                </span>
                <span className={`badge badge--${toneOf(upcoming.settlement.status)}`}>{STATUS_LABEL[upcoming.settlement.status]}</span>
              </Link>
            </div>
          ) : !salariesLoading && hasAnySettlement ? (
            <EmptyState icon={<Wallet size={22} />} title="All settled up" text="Every settlement for this household has been paid in full." tone="coral" />
          ) : !salariesLoading ? (
            <EmptyState icon={<Wallet size={22} />} title="Nothing due" text="Salaries appear here a few days before they're due." tone="coral" />
          ) : null}
        </section>
      </div>
    </>
  );
}
