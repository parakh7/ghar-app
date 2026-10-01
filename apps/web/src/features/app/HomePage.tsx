import { ClipboardCheck, ReceiptIndianRupee, Users, Wallet } from "lucide-react";
import { useSession } from "../auth/session";
import { greeting, longDate } from "../../lib/format";
import { EmptyState } from "../../components/EmptyState";
import { VerifyEmailBanner } from "./VerifyEmailBanner";
import { useActiveHousehold } from "./useActiveHousehold";

/**
 * Phase 1: real greeting + household-local date. The "Today" sections are driven by
 * the TodayService (Phase 8); until their data exists they show honest empty states.
 */
export function HomePage() {
  const { data } = useSession();
  const { household } = useActiveHousehold();
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
          <EmptyState icon={<Wallet size={22} />} title="Nothing due" text="Salaries appear here a few days before they're due." tone="coral" />
        </section>
      </div>
    </>
  );
}
