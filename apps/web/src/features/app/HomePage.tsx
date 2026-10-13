import { ClipboardCheck, ReceiptIndianRupee, Users, Wallet } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { formatINR } from "@household/shared";
import { useSession } from "../auth/session";
import { greeting, longDate } from "../../lib/format";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { VerifyEmailBanner } from "./VerifyEmailBanner";
import { STATUS_LABEL, toneOf } from "./salary/statusTone";
import { useActiveHousehold } from "./useActiveHousehold";
import { useTodayDashboard } from "./useTodayDashboard";

/** "2026-10-01" -> "October 2026". */
function monthLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function HomePage() {
  const { data } = useSession();
  const navigate = useNavigate();
  const { household } = useActiveHousehold();
  const dashboardQuery = useTodayDashboard(household?.id);
  const dashboard = dashboardQuery.data;
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
        {dashboard?.attendance && (
          <section className="card card--enter" style={{ animationDelay: "0ms" }} aria-labelledby="h-help">
            <h2 className="card__title" id="h-help">Househelp</h2>
            {dashboard.attendance.total === 0 ? (
              <EmptyState icon={<Users size={22} />} title="No househelps yet" text="Add the people who help at home to track who's coming each day." tone="coral" />
            ) : (
              <div className="list">
                <Link to="/attendance" className="list__item">
                  <span className="list__label">{dashboard.attendance.marked} of {dashboard.attendance.total} marked today</span>
                </Link>
              </div>
            )}
          </section>
        )}
        {dashboard?.checklist && (
          <section className="card card--enter" style={{ animationDelay: "70ms" }} aria-labelledby="h-work">
            <h2 className="card__title" id="h-work">Today's work</h2>
            {dashboard.checklist.total === 0 ? (
              <EmptyState icon={<ClipboardCheck size={22} />} title="No tasks for today" text="Create a checklist — daily dusting, Saturday bathrooms — and tick things off as they're done." tone="amber" />
            ) : (
              <div className="list">
                <Link to="/checklist/today" className="list__item">
                  <span className="list__label">{dashboard.checklist.done} of {dashboard.checklist.total} done</span>
                </Link>
                {dashboard.checklist.pending.map((name) => (
                  <div key={name} className="list__item"><span className="list__meta">{name}</span></div>
                ))}
              </div>
            )}
          </section>
        )}
        {dashboard?.bills && (
          <section className="card card--enter" style={{ animationDelay: "140ms" }} aria-labelledby="h-pay">
            <h2 className="card__title" id="h-pay">Payments</h2>
            {dashboard.bills.length === 0 ? (
              <EmptyState icon={<ReceiptIndianRupee size={22} />} title="Nothing due today" text="Bills due today or overdue show up here. Check the Bills page for everything you're tracking." tone="dusk" />
            ) : (
              <div className="list">
                {dashboard.bills.map((b) => (
                  <Link key={b.occurrenceId} to={`/bills/${b.billId}`} className="list__item">
                    <span className="list__text">
                      <span className="list__label" style={{ display: "block" }}>{b.billName}</span>
                      <span className="list__meta">{formatINR(b.amountDuePaise)} · {b.dueDate}</span>
                    </span>
                    {b.isOverdue && <span className="badge badge--error">Overdue</span>}
                  </Link>
                ))}
              </div>
            )}
          </section>
        )}
        {dashboard?.salary && (
          <section className="card card--enter" style={{ animationDelay: "210ms" }} aria-labelledby="h-sal">
            <h2 className="card__title" id="h-sal">Salaries</h2>
            {dashboard.salary.upcoming ? (
              <div className="list">
                <Link to={`/salary/${dashboard.salary.upcoming.settlementId}`} className="list__item">
                  <span className="list__text">
                    <span className="list__label" style={{ display: "block" }}>{dashboard.salary.upcoming.househelpName} · {monthLabel(dashboard.salary.upcoming.periodMonth)}</span>
                    <span className="list__meta">{formatINR(dashboard.salary.upcoming.netDuePaise)} due</span>
                  </span>
                  <span className={`badge badge--${toneOf(dashboard.salary.upcoming.status)}`}>{STATUS_LABEL[dashboard.salary.upcoming.status]}</span>
                </Link>
              </div>
            ) : dashboard.salary.hasAnySettlement ? (
              <EmptyState
                icon={<Wallet size={22} />} title="All settled up" text="Every settlement for this household has been paid in full." tone="coral"
                action={<Button variant="secondary" onClick={() => navigate("/salary")}>View all salaries</Button>}
              />
            ) : (
              <EmptyState
                icon={<Wallet size={22} />} title="Nothing due" text="Salaries appear here a few days before they're due." tone="coral"
                action={<Button variant="secondary" onClick={() => navigate("/salary")}>View all salaries</Button>}
              />
            )}
          </section>
        )}
      </div>
    </>
  );
}
