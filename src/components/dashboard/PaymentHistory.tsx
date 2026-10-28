import { CreditCard, CheckCircle2, XCircle, Clock, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { GlassCard } from '@/components/ui/GlassCard';
import { usePaymentHistory } from '@/hooks/usePaymentHistory';
import { format } from 'date-fns';

const statusMeta: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive'; icon: typeof CheckCircle2 }> = {
  paid:      { label: 'Paid',      variant: 'default',     icon: CheckCircle2 },
  approved:  { label: 'Paid',      variant: 'default',     icon: CheckCircle2 },
  failed:    { label: 'Failed',    variant: 'destructive', icon: XCircle },
  cancelled: { label: 'Cancelled', variant: 'secondary',   icon: XCircle },
  created:   { label: 'Pending',   variant: 'secondary',   icon: Clock },
};

export function PaymentHistory() {
  const { records, loading, error } = usePaymentHistory();

  if (loading) {
    return (
      <GlassCard>
        <div className="flex items-center gap-3 mb-4">
          <CreditCard className="w-5 h-5 text-primary" />
          <h3 className="font-display text-lg font-semibold">Payment History</h3>
        </div>
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-14 rounded-xl bg-muted/40 animate-pulse" />
          ))}
        </div>
      </GlassCard>
    );
  }

  if (error) {
    return (
      <GlassCard>
        <div className="flex items-center gap-3 mb-4">
          <CreditCard className="w-5 h-5 text-primary" />
          <h3 className="font-display text-lg font-semibold">Payment History</h3>
        </div>
        <p className="text-sm text-destructive">Could not load payment history.</p>
      </GlassCard>
    );
  }

  return (
    <GlassCard>
      <div className="flex items-center gap-3 mb-4">
        <CreditCard className="w-5 h-5 text-primary" />
        <h3 className="font-display text-lg font-semibold">Payment History</h3>
      </div>

      {records.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payment records yet.</p>
      ) : (
        <div className="space-y-3">
          {records.map((rec) => {
            const meta = statusMeta[rec.status] ?? { label: rec.status, variant: 'secondary' as const, icon: Clock };
            const Icon = meta.icon;
            const isPaid = rec.status === 'paid' || rec.status === 'approved';
            const isActive = isPaid && rec.expires_at && new Date(rec.expires_at) > new Date();
            const sourceLabel = rec.source === 'razorpay' ? 'via Razorpay' : 'via UPI';
            return (
              <div
                key={rec.id}
                className="flex items-center justify-between gap-4 rounded-xl border border-border/50 bg-muted/20 px-4 py-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Icon className={`w-4 h-4 shrink-0 ${isPaid ? 'text-green-500' : rec.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      GradPrep AI Pro <span className="text-xs font-normal text-muted-foreground">{sourceLabel}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(rec.created_at), 'dd MMM yyyy')}
                      {isActive && rec.expires_at && (
                        <> · valid till {format(new Date(rec.expires_at), 'dd MMM yyyy')}</>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-sm font-semibold">₹{rec.amount.toLocaleString('en-IN')}</span>
                  <Badge variant={meta.variant} className="text-xs">
                    {meta.label}
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {records.length > 0 && (
        <a
          href="/subscription"
          className="mt-4 flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Manage subscription <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </GlassCard>
  );
}
