import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useSubscription } from '@/hooks/useSubscription';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Shield, UserPlus, Trash2, Crown, Users, ArrowLeft, Building2, Check, X, Clock, Wallet, IndianRupee, TrendingUp, BookOpen, Brain, Loader2, Plus, Eye, EyeOff } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface UserRole {
  id: string;
  user_id: string;
  role: 'admin' | 'moderator' | 'user';
  created_at: string;
  email?: string;
}

interface Profile {
  user_id: string;
  email: string | null;
  display_name: string | null;
}

interface EnterpriseRequest {
  id: string;
  user_id: string;
  user_email: string;
  user_name: string | null;
  organization: string | null;
  message: string | null;
  status: string;
  created_at: string;
}

interface UpiPayment {
  id: string;
  user_id: string;
  email: string | null;
  amount: number;
  plan: string;
  upi_reference: string;
  payer_phone: string | null;
  status: string;
  starts_at: string;
  expires_at: string;
  created_at: string;
}

interface RazorpayPayment {
  id: string;
  user_id: string;
  email: string | null;
  amount_paise: number;
  currency: string;
  plan: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  status: string;
  starts_at: string | null;
  expires_at: string | null;
  created_at: string;
}

const Admin = () => {
  const { user, loading: authLoading } = useAuth();
  const { isAdmin, loading: subLoading } = useSubscription();
  const navigate = useNavigate();
  
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [enterpriseRequests, setEnterpriseRequests] = useState<EnterpriseRequest[]>([]);
  const [adminUsers, setAdminUsers] = useState<Array<{ id: string; email: string | null }>>([]);
  const [totalUsers, setTotalUsers] = useState(0);
  const [payments, setPayments] = useState<UpiPayment[]>([]);
  const [razorpayPayments, setRazorpayPayments] = useState<RazorpayPayment[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'moderator'>('admin');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  // Custom Question Bank state
  const [cqbTitle, setCqbTitle] = useState('');
  const [cqbRole, setCqbRole] = useState('');
  const [cqbDifficulty, setCqbDifficulty] = useState('intermediate');
  const [cqbSaving, setCqbSaving] = useState(false);

  // Aptitude Question state
  const [aptTopicId, setAptTopicId] = useState('');
  const [aptQuestion, setAptQuestion] = useState('');
  const [aptOptA, setAptOptA] = useState('');
  const [aptOptB, setAptOptB] = useState('');
  const [aptOptC, setAptOptC] = useState('');
  const [aptOptD, setAptOptD] = useState('');
  const [aptCorrect, setAptCorrect] = useState('A');
  const [aptExplanation, setAptExplanation] = useState('');
  const [aptDifficulty, setAptDifficulty] = useState('medium');
  const [aptSaving, setAptSaving] = useState(false);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (authLoading || subLoading) return;
    if (!user) { navigate('/signin'); return; }
    if (!isAdmin) {
      toast.error('Access denied. Admin privileges required.');
      navigate('/dashboard');
    }
  }, [isAdmin, subLoading, authLoading, user, navigate]);

  useEffect(() => {
    if (isAdmin) fetchData();
  }, [isAdmin]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const { data: usersPayload, error: usersError } = await supabase.functions.invoke('admin-users');
      if (usersError) throw usersError;
      if (usersPayload?.error) throw new Error(String(usersPayload.error));

      const users = (usersPayload?.users || []) as Array<{ id: string; email: string | null }>;
      const total = typeof usersPayload?.total === 'number' ? usersPayload.total : users.length;
      const rolesData = (usersPayload?.roles || []) as UserRole[];
      const requestsData = (usersPayload?.enterpriseRequests || []) as EnterpriseRequest[];
      const paymentsData = (usersPayload?.payments || []) as UpiPayment[];
      const rzpPaymentsData = (usersPayload?.razorpayPayments || []) as RazorpayPayment[];

      setAdminUsers(users);
      setTotalUsers(total);
      setProfiles(users.map((u) => ({ user_id: u.id, email: u.email, display_name: null })));
      setEnterpriseRequests(requestsData);
      setPayments(paymentsData);
      setRazorpayPayments(rzpPaymentsData);

      const rolesWithEmail = rolesData.map((role) => {
        const u = users.find((x) => x.id === role.user_id);
        return { ...role, email: u?.email || 'Unknown' };
      });
      setRoles(rolesWithEmail);
    } catch (error) {
      console.error('Error fetching data:', error);
      toast.error('Failed to load admin data');
    } finally {
      setLoading(false);
    }
  };

  const handleApproveRequest = async (request: EnterpriseRequest) => {
    try {
      const { error: roleError } = await supabase
        .from('user_roles')
        .insert({ user_id: request.user_id, role: 'moderator' });
      if (roleError && !roleError.message.includes('duplicate')) throw roleError;

      const { error: updateError } = await supabase
        .from('enterprise_requests')
        .update({ status: 'approved', reviewed_by: user?.id, reviewed_at: new Date().toISOString() })
        .eq('id', request.id);
      if (updateError) throw updateError;

      toast.success(`Approved! ${request.user_email} now has Pro access.`);
      fetchData();
    } catch (error) {
      console.error('Error approving request:', error);
      toast.error('Failed to approve request');
    }
  };

  const handleRejectRequest = async (request: EnterpriseRequest) => {
    if (!confirm(`Reject request from ${request.user_email}?`)) return;
    try {
      const { error } = await supabase
        .from('enterprise_requests')
        .update({ status: 'rejected', reviewed_by: user?.id, reviewed_at: new Date().toISOString() })
        .eq('id', request.id);
      if (error) throw error;
      toast.success('Request rejected');
      fetchData();
    } catch (error) {
      console.error('Error rejecting request:', error);
      toast.error('Failed to reject request');
    }
  };

  const handleAddRole = async () => {
    if (!newEmail.trim()) { toast.error('Please enter an email address'); return; }
    setAdding(true);
    try {
      const email = newEmail.trim().toLowerCase();
      const foundUser = adminUsers.find((u) => (u.email || '').toLowerCase() === email);
      if (!foundUser) { toast.error('User not found. They must sign up first.'); return; }

      const existingRole = roles.find((r) => r.user_id === foundUser.id && r.role === newRole);
      if (existingRole) { toast.error('User already has this role'); return; }

      const { error } = await supabase.from('user_roles').insert({ user_id: foundUser.id, role: newRole });
      if (error) throw error;

      toast.success(`${newRole} role granted to ${newEmail}`);
      setNewEmail('');
      fetchData();
    } catch (error) {
      console.error('Error adding role:', error);
      toast.error('Failed to add role');
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveRole = async (roleId: string, email: string) => {
    if (!confirm(`Remove role from ${email}?`)) return;
    try {
      const { error } = await supabase.from('user_roles').delete().eq('id', roleId);
      if (error) throw error;
      toast.success('Role removed');
      fetchData();
    } catch (error) {
      console.error('Error removing role:', error);
      toast.error('Failed to remove role');
    }
  };

  if (authLoading || subLoading || loading) {
    return (
      <MainLayout>
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      </MainLayout>
    );
  }

  if (!user || !isAdmin) return null;

  const now = Date.now();

  // UPI revenue
  const activeUpiPayments = payments.filter(
    (p) => p.status === 'approved' && new Date(p.expires_at).getTime() > now
  ).length;
  const upiRevenue = payments
    .filter((p) => p.status === 'approved')
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  // Razorpay revenue
  const activeRzpPayments = razorpayPayments.filter(
    (p) => p.status === 'paid' && p.expires_at && new Date(p.expires_at).getTime() > now
  ).length;
  const rzpRevenue = razorpayPayments
    .filter((p) => p.status === 'paid')
    .reduce((s, p) => s + Math.round(Number(p.amount_paise || 0) / 100), 0);

  const activePayments = activeUpiPayments + activeRzpPayments;
  const totalRevenue   = upiRevenue + rzpRevenue;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthRevenue = payments
    .filter((p) => p.status === 'approved' && new Date(p.created_at) >= monthStart)
    .reduce((s, p) => s + Number(p.amount || 0), 0)
    + razorpayPayments
    .filter((p) => p.status === 'paid' && new Date(p.created_at) >= monthStart)
    .reduce((s, p) => s + Math.round(Number(p.amount_paise || 0) / 100), 0);

  const emailFor = (userId: string, fallback: string | null) =>
    adminUsers.find((u) => u.id === userId)?.email || fallback || 'Unknown';

  return (
    <MainLayout>
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        <Button variant="ghost" onClick={() => navigate('/dashboard')} className="mb-6">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Dashboard
        </Button>

        <div className="flex items-center gap-3 mb-8">
          <Shield className="w-8 h-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">Admin Dashboard</h1>
            <p className="text-muted-foreground">Manage users and access permissions</p>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid md:grid-cols-3 gap-4 mb-8">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Users</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-primary" />
                <span className="text-2xl font-bold">{totalUsers}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Admins</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-red-500" />
                <span className="text-2xl font-bold">{roles.filter(r => r.role === 'admin').length}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Moderators</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Crown className="w-5 h-5 text-yellow-500" />
                <span className="text-2xl font-bold">{roles.filter(r => r.role === 'moderator').length}</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Pending Requests</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-orange-500" />
                <span className="text-2xl font-bold">
                  {enterpriseRequests.filter(r => r.status === 'pending').length}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Wallet */}
        <Card className="mb-8 border-primary/30 animate-fade-in-up">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="w-5 h-5 text-primary" />
              Wallet & Subscriptions
            </CardTitle>
            <CardDescription>Revenue collected from Pro subscriptions (UPI / PhonePe)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 transition-transform hover:-translate-y-1">
                <p className="text-xs text-muted-foreground mb-1">Total earnings</p>
                <p className="text-2xl font-bold flex items-center">
                  <IndianRupee className="w-5 h-5" />{totalRevenue.toLocaleString('en-IN')}
                </p>
              </div>
              <div className="rounded-xl border border-glass-border/30 p-4 transition-transform hover:-translate-y-1">
                <p className="text-xs text-muted-foreground mb-1">This month</p>
                <p className="text-2xl font-bold flex items-center">
                  <IndianRupee className="w-5 h-5" />{monthRevenue.toLocaleString('en-IN')}
                </p>
              </div>
              <div className="rounded-xl border border-glass-border/30 p-4 transition-transform hover:-translate-y-1">
                <p className="text-xs text-muted-foreground mb-1">Active Pro subscribers</p>
                <p className="text-2xl font-bold flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-primary" />{activePayments}
                </p>
              </div>
              <div className="rounded-xl border border-glass-border/30 p-4 transition-transform hover:-translate-y-1">
                <p className="text-xs text-muted-foreground mb-1">Total payments</p>
                <p className="text-2xl font-bold">{payments.length + razorpayPayments.length}</p>
              </div>
            </div>

            {/* UPI payments table */}
            {payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No subscription payments yet.</p>
            ) : (
              <>
                <h4 className="text-sm font-semibold text-foreground mt-2">UPI / QR Payments</h4>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Reference</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead>Paid on</TableHead>
                        <TableHead>Valid till</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.slice(0, 25).map((p) => {
                        const active = new Date(p.expires_at).getTime() > now && p.status === 'approved';
                        return (
                          <TableRow key={p.id}>
                            <TableCell className="font-medium">{emailFor(p.user_id, p.email)}</TableCell>
                            <TableCell>₹{Number(p.amount).toLocaleString('en-IN')}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{p.upi_reference}</TableCell>
                            <TableCell>{p.payer_phone ? `+91 ${p.payer_phone}` : '—'}</TableCell>
                            <TableCell>{new Date(p.created_at).toLocaleDateString()}</TableCell>
                            <TableCell>{new Date(p.expires_at).toLocaleDateString()}</TableCell>
                            <TableCell>
                              <Badge variant={active ? 'default' : 'secondary'}>
                                {active ? 'Active' : 'Expired'}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}

            {/* Razorpay payments table */}
            {razorpayPayments.length > 0 && (
              <>
                <h4 className="text-sm font-semibold text-foreground mt-6">Razorpay Payments</h4>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Payment ID</TableHead>
                        <TableHead>Paid on</TableHead>
                        <TableHead>Valid till</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {razorpayPayments.slice(0, 25).map((p) => {
                        const active = p.status === 'paid' && p.expires_at && new Date(p.expires_at).getTime() > now;
                        return (
                          <TableRow key={p.id}>
                            <TableCell className="font-medium">{emailFor(p.user_id, p.email)}</TableCell>
                            <TableCell>₹{Math.round(Number(p.amount_paise) / 100).toLocaleString('en-IN')}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{p.razorpay_payment_id ?? '—'}</TableCell>
                            <TableCell>{new Date(p.created_at).toLocaleDateString()}</TableCell>
                            <TableCell>{p.expires_at ? new Date(p.expires_at).toLocaleDateString() : '—'}</TableCell>
                            <TableCell>
                              <Badge variant={active ? 'default' : p.status === 'failed' ? 'destructive' : 'secondary'}>
                                {active ? 'Active' : p.status === 'created' ? 'Pending' : p.status === 'failed' ? 'Failed' : 'Expired'}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Enterprise Requests */}
        {enterpriseRequests.filter(r => r.status === 'pending').length > 0 && (
          <Card className="mb-8 border-orange-500/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-orange-500" />
                Enterprise Access Requests
              </CardTitle>
              <CardDescription>Users requesting Pro access for their organization</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {enterpriseRequests.filter(r => r.status === 'pending').map((request) => (
                    <TableRow key={request.id}>
                      <TableCell>
                        <div>
                          <div className="font-medium">{request.user_name}</div>
                          <div className="text-sm text-muted-foreground">{request.user_email}</div>
                        </div>
                      </TableCell>
                      <TableCell>{request.organization}</TableCell>
                      <TableCell className="max-w-xs truncate">{request.message || '-'}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(request.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="default" onClick={() => handleApproveRequest(request)}>
                            <Check className="w-4 h-4 mr-1" />
                            Approve
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => handleRejectRequest(request)}>
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {/* Grant Access */}
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="w-5 h-5" />
              Grant Access
            </CardTitle>
            <CardDescription>
              Add admin or moderator privileges to a user. They must have signed up first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-4">
              <Input
                type="email"
                placeholder="user@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="flex-1"
              />
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as 'admin' | 'moderator')}
                className="px-4 py-2 rounded-md border border-input bg-background"
              >
                <option value="admin">Admin (Full Access)</option>
                <option value="moderator">Moderator (Pro Access)</option>
              </select>
              <Button onClick={handleAddRole} disabled={adding}>
                {adding ? 'Adding...' : 'Grant Access'}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              <strong>Admin:</strong> Full access + can manage other users.{' '}
              <strong>Moderator:</strong> Pro features only.
            </p>
          </CardContent>
        </Card>

        {/* Roles Table */}
        <Card>
          <CardHeader>
            <CardTitle>User Roles</CardTitle>
            <CardDescription>Users with special access privileges</CardDescription>
          </CardHeader>
          <CardContent>
            {roles.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No special roles assigned yet. Add your first admin above.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roles.map((role) => (
                    <TableRow key={role.id}>
                      <TableCell className="font-medium">{role.email}</TableCell>
                      <TableCell>
                        <Badge variant={role.role === 'admin' ? 'destructive' : 'secondary'}>
                          {role.role === 'admin' && <Shield className="w-3 h-3 mr-1" />}
                          {role.role === 'moderator' && <Crown className="w-3 h-3 mr-1" />}
                          {role.role}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(role.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {role.user_id !== user?.id && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveRole(role.id, role.email || '')}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* ── CUSTOM QUESTION BANK ── */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Brain className="w-5 h-5 text-emerald-500" />
              Custom Question Bank Management
            </CardTitle>
            <CardDescription>Create shared question sets that all users can access during custom interviews.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Set Title *</Label>
                <Input value={cqbTitle} onChange={(e) => setCqbTitle(e.target.value)} placeholder="e.g. System Design Q&A" className="mt-1 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Target Role</Label>
                <Input value={cqbRole} onChange={(e) => setCqbRole(e.target.value)} placeholder="e.g. Backend Engineer" className="mt-1 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Difficulty</Label>
                <Select value={cqbDifficulty} onValueChange={setCqbDifficulty}>
                  <SelectTrigger className="mt-1 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="beginner">Beginner</SelectItem>
                    <SelectItem value="intermediate">Intermediate</SelectItem>
                    <SelectItem value="advanced">Advanced</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button
              disabled={!cqbTitle.trim() || cqbSaving}
              onClick={async () => {
                if (!user?.id) return;
                setCqbSaving(true);
                try {
                  const { error } = await supabase.from('custom_question_sets').insert({
                    user_id: user.id,
                    title: cqbTitle.trim(),
                    target_role: cqbRole || null,
                    difficulty: cqbDifficulty,
                    is_admin_set: true,
                    is_published: true,
                    processing_status: 'ready',
                  });
                  if (error) throw error;
                  toast.success('Question set created and published!');
                  setCqbTitle(''); setCqbRole('');
                  queryClient.invalidateQueries({ queryKey: ['admin_question_sets'] });
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Failed to create set');
                } finally {
                  setCqbSaving(false);
                }
              }}
            >
              {cqbSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
              Create & Publish Set
            </Button>
            <p className="text-xs text-muted-foreground">
              After creating a set, open it from the Custom Interview page (as admin) to add questions via upload or manual entry.
            </p>

            {/* List existing admin sets */}
            <AdminQuestionSets userId={user!.id} />
          </CardContent>
        </Card>

        {/* ── APTITUDE QUESTION MANAGEMENT ── */}
        <Card className="mt-8 mb-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-orange-500" />
              Aptitude Question Management
            </CardTitle>
            <CardDescription>Add validated questions to the global aptitude bank. Select a topic, fill in the question and answer, then publish.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <AptitudeTopicSelector value={aptTopicId} onChange={setAptTopicId} />
            <div>
              <Label className="text-xs">Question Text *</Label>
              <Textarea value={aptQuestion} onChange={(e) => setAptQuestion(e.target.value)} placeholder="Enter the question…" className="mt-1 text-sm min-h-[80px]" />
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              {(['A','B','C','D'] as const).map((opt, idx) => {
                const vals = [aptOptA, aptOptB, aptOptC, aptOptD];
                const setters = [setAptOptA, setAptOptB, setAptOptC, setAptOptD];
                return (
                  <div key={opt}>
                    <Label className="text-xs">Option {opt}</Label>
                    <Input value={vals[idx]} onChange={(e) => setters[idx](e.target.value)} placeholder={`Option ${opt}`} className="mt-1 text-sm" />
                  </div>
                );
              })}
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Correct Answer *</Label>
                <Select value={aptCorrect} onValueChange={setAptCorrect}>
                  <SelectTrigger className="mt-1 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['A','B','C','D'].map(o => <SelectItem key={o} value={o}>Option {o}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Difficulty</Label>
                <Select value={aptDifficulty} onValueChange={setAptDifficulty}>
                  <SelectTrigger className="mt-1 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="easy">Easy</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="hard">Hard</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs">Explanation (required before publishing) *</Label>
              <Textarea value={aptExplanation} onChange={(e) => setAptExplanation(e.target.value)} placeholder="Explain step-by-step why the answer is correct…" className="mt-1 text-sm" />
            </div>
            <Button
              disabled={!aptTopicId || !aptQuestion.trim() || !aptExplanation.trim() || aptSaving}
              onClick={async () => {
                if (!user?.id || !aptTopicId) return;
                // Validate all options filled
                if (!aptOptA || !aptOptB || !aptOptC || !aptOptD) {
                  toast.error('Please fill all four options.');
                  return;
                }
                // Fetch topic to get category_id
                const { data: topicData } = await supabase.from('aptitude_topics').select('category_id').eq('id', aptTopicId).single();
                if (!topicData) { toast.error('Topic not found'); return; }
                setAptSaving(true);
                try {
                  const { error } = await supabase.from('aptitude_questions').insert({
                    topic_id: aptTopicId,
                    category_id: topicData.category_id,
                    question_text: aptQuestion.trim(),
                    question_type: 'mcq',
                    options: [
                      { id: 'A', text: aptOptA },
                      { id: 'B', text: aptOptB },
                      { id: 'C', text: aptOptC },
                      { id: 'D', text: aptOptD },
                    ],
                    correct_answer: aptCorrect,
                    explanation: aptExplanation.trim(),
                    difficulty: aptDifficulty,
                    marks: 1,
                    is_published: true,
                    is_validated: true,
                    created_by: user.id,
                  });
                  if (error) throw error;
                  toast.success('Question published to aptitude bank!');
                  setAptQuestion(''); setAptOptA(''); setAptOptB(''); setAptOptC(''); setAptOptD('');
                  setAptExplanation(''); setAptTopicId('');
                  queryClient.invalidateQueries({ queryKey: ['aptitude_questions'] });
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Failed to save question');
                } finally {
                  setAptSaving(false);
                }
              }}
            >
              {aptSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
              Validate & Publish Question
            </Button>
            <p className="text-xs text-muted-foreground">
              Only questions with a filled explanation are published. Verify the answer matches the explanation before saving.
            </p>
          </CardContent>
        </Card>
      </div>
    </MainLayout>
  );
};

// ── Helper components ──────────────────────────────────────────────────────

function AdminQuestionSets({ userId }: { userId: string }) {
  const { data: sets = [], isLoading } = useQuery({
    queryKey: ['admin_question_sets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('custom_question_sets')
        .select('id, title, target_role, question_count, is_published, created_at')
        .eq('is_admin_set', true)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
  });
  const qc = useQueryClient();

  const togglePublish = async (id: string, currentState: boolean) => {
    await supabase.from('custom_question_sets').update({ is_published: !currentState }).eq('id', id);
    qc.invalidateQueries({ queryKey: ['admin_question_sets'] });
  };

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (sets.length === 0) return <p className="text-sm text-muted-foreground">No admin question sets yet.</p>;

  return (
    <div className="space-y-2 mt-2">
      <p className="text-xs font-medium text-muted-foreground">Existing Admin Sets ({sets.length})</p>
      {sets.map((s: { id: string; title: string; target_role: string | null; question_count: number; is_published: boolean; created_at: string }) => (
        <div key={s.id} className="flex items-center justify-between p-2 border border-border/30 rounded-lg text-sm">
          <div>
            <span className="font-medium text-foreground">{s.title}</span>
            {s.target_role && <span className="text-muted-foreground ml-2">({s.target_role})</span>}
            <span className="text-muted-foreground ml-2">· {s.question_count} Qs</span>
          </div>
          <div className="flex gap-2">
            <Badge variant={s.is_published ? 'default' : 'secondary'} className="text-xs">
              {s.is_published ? 'Published' : 'Draft'}
            </Badge>
            <Button size="sm" variant="ghost" onClick={() => togglePublish(s.id, s.is_published)}>
              {s.is_published ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function AptitudeTopicSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: categories = [] } = useQuery({
    queryKey: ['aptitude_categories'],
    queryFn: async () => {
      const { data } = await supabase.from('aptitude_categories').select('*').order('sort_order');
      return data || [];
    },
  });

  const [selectedCat, setSelectedCat] = useState('');

  const { data: topics = [] } = useQuery({
    queryKey: ['aptitude_topics', selectedCat],
    queryFn: async () => {
      if (!selectedCat) return [];
      const { data } = await supabase.from('aptitude_topics').select('*').eq('category_id', selectedCat).order('sort_order');
      return data || [];
    },
    enabled: !!selectedCat,
  });

  return (
    <div className="grid md:grid-cols-2 gap-3">
      <div>
        <Label className="text-xs">Category *</Label>
        <Select value={selectedCat} onValueChange={(v) => { setSelectedCat(v); onChange(''); }}>
          <SelectTrigger className="mt-1 text-sm"><SelectValue placeholder="Select category" /></SelectTrigger>
          <SelectContent>
            {categories.map((c: { id: string; name: string }) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-xs">Topic *</Label>
        <Select value={value} onValueChange={onChange} disabled={!selectedCat}>
          <SelectTrigger className="mt-1 text-sm"><SelectValue placeholder="Select topic" /></SelectTrigger>
          <SelectContent>
            {topics.map((t: { id: string; name: string }) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export default Admin;
