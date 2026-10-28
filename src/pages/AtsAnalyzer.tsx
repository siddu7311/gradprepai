import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Helmet } from 'react-helmet-async';
import {
  Target, Upload, FileText, CheckCircle, AlertCircle, AlertTriangle,
  ChevronDown, ChevronUp, Loader2, BarChart3, TrendingUp, Download,
  RefreshCw, X, Info, Search, Lightbulb, Clock
} from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { GlassCard } from '@/components/ui/GlassCard';
import { GlowButton } from '@/components/ui/GlowButton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { extractTextFromFile, isValidResumeFile } from '@/lib/documentParser';
import { useAtsAnalyzer, type AtsAnalysisResult } from '@/hooks/useAtsAnalyzer';

const MAX_FILE_MB = 10;
const PRIORITY_COLORS = {
  high: 'text-red-400 border-red-400/30 bg-red-500/10',
  medium: 'text-yellow-400 border-yellow-400/30 bg-yellow-500/10',
  optional: 'text-blue-400 border-blue-400/30 bg-blue-500/10',
};

function ScoreRing({ score, label, color }: { score: number; label: string; color: string }) {
  const radius = 36;
  const circ = 2 * Math.PI * radius;
  const offset = circ - (score / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative w-24 h-24">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 88 88">
          <circle cx="44" cy="44" r={radius} fill="none" strokeWidth="8" className="stroke-muted/30" />
          <circle
            cx="44" cy="44" r={radius} fill="none" strokeWidth="8"
            stroke={color} strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 1s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-2xl font-bold text-foreground">{score}</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground text-center">{label}</p>
    </div>
  );
}

export default function AtsAnalyzer() {
  const { user } = useAuth();
  const { analyzing, error: analysisError, analyze } = useAtsAnalyzer();

  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [resumeText, setResumeText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');
  const [result, setResult] = useState<AtsAnalysisResult | null>(null);
  const [activeTab, setActiveTab] = useState<'analyze' | 'history'>('analyze');

  const { data: history = [] } = useQuery({
    queryKey: ['ats_analyses', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('ats_analyses')
        .select('id, ats_readiness_score, resume_file_name, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });

  const handleFileChange = async (f: File) => {
    setFile(null);
    setResumeText('');
    setResult(null);
    setExtractError('');
    if (!isValidResumeFile(f)) {
      setExtractError('Unsupported format. Please upload PDF, DOCX, or TXT.');
      return;
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      setExtractError(`File too large. Maximum size is ${MAX_FILE_MB} MB.`);
      return;
    }
    setExtracting(true);
    try {
      const text = await extractTextFromFile(f);
      if (!text.trim()) {
        throw new Error(
          'No readable text could be extracted. If this is a scanned PDF, try a clearer scan or upload a text-based PDF or DOCX/TXT resume.',
        );
      }
      setFile(f);
      setResumeText(text.trim());
      toast.success('Resume text extracted.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read file';
      setExtractError(message);
      toast.error(message);
    } finally {
      setExtracting(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFileChange(f);
  };

  const handleAnalyze = async () => {
    if (!resumeText.trim()) {
      toast.error('Please upload a resume first.');
      return;
    }
    try {
      const res = await analyze({
        resume_text: resumeText,
        resume_file_name: file?.name,
      });
      setResult(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
    }
  };

  const handleReanalyze = async () => {
    if (!result || !resumeText.trim()) return;
    try {
      const res = await analyze({
        resume_text: resumeText,
        resume_file_name: file?.name,
        parent_analysis_id: result.id,
      });
      setResult(res);
      toast.success('Re-analyzed successfully!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Re-analysis failed');
    }
  };

  if (!user) {
    return (
      <MainLayout>
        <div className="container mx-auto px-4 py-12 text-center">
          <p className="text-muted-foreground">Please sign in to use the ATS Analyzer.</p>
        </div>
      </MainLayout>
    );
  }

  return (
    <>
      <Helmet>
        <title>ATS Resume Analyzer - GradPrep AI</title>
        <meta name="description" content="Check your resume's ATS readiness and job description match score." />
      </Helmet>
      <MainLayout>
        <div className="container mx-auto px-4 py-8 max-w-5xl">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
            <h1 className="font-display text-3xl font-bold text-foreground mb-2 flex items-center gap-3">
              <Target className="w-8 h-8 text-primary" />
              ATS Resume Analyzer
            </h1>
            <p className="text-muted-foreground">
              Check how ATS-friendly your resume is and how well it matches a job description.
              <span className="text-xs ml-2 text-muted-foreground/70">(Scores are GradPrep AI estimates, not actual ATS results.)</span>
            </p>
          </motion.div>

          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
            <TabsList className="mb-6">
              <TabsTrigger value="analyze">Analyze Resume</TabsTrigger>
              <TabsTrigger value="history">History ({history.length})</TabsTrigger>
            </TabsList>

            {/* ── ANALYZE TAB ── */}
            <TabsContent value="analyze">
              <div className="grid lg:grid-cols-2 gap-6">
                {/* Input panel */}
                <div className="space-y-4">
                  <GlassCard className="p-5 space-y-4">
                    <h2 className="font-semibold text-foreground">1. Upload Resume</h2>
                    <div
                      className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                        dragOver ? 'border-primary bg-primary/5' : 'border-border/50 hover:border-primary/50'
                      }`}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={handleDrop}
                      onClick={() => document.getElementById('ats-file-input')?.click()}
                    >
                      <input
                        id="ats-file-input" type="file" accept=".pdf,.docx,.doc,.txt" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleFileChange(f); }}
                      />
                      {extracting ? (
                        <div className="flex flex-col items-center gap-2">
                          <Loader2 className="w-8 h-8 animate-spin text-primary" />
                          <p className="text-sm text-muted-foreground">Extracting text…</p>
                        </div>
                      ) : file ? (
                        <div className="flex items-center justify-center gap-3">
                          <FileText className="w-6 h-6 text-green-500" />
                          <span className="text-sm font-medium">{file.name}</span>
                          <button onClick={(e) => { e.stopPropagation(); setFile(null); setResumeText(''); }}>
                            <X className="w-4 h-4 text-muted-foreground hover:text-foreground" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <Upload className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                          <p className="text-sm text-foreground font-medium">Drop PDF, DOCX, or TXT</p>
                          <p className="text-xs text-muted-foreground">Max {MAX_FILE_MB} MB</p>
                        </>
                      )}
                    </div>
                    {extractError && (
                      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        <span>{extractError}</span>
                      </p>
                    )}
                    {resumeText && (
                      <div className="text-xs text-muted-foreground border border-border/30 rounded p-2 max-h-24 overflow-y-auto">
                        {resumeText.slice(0, 300)}…
                      </div>
                    )}
                  </GlassCard>

                  <div className="flex gap-3">
                    {result ? (
                      <GlowButton onClick={handleReanalyze} disabled={analyzing} className="flex-1">
                        {analyzing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Re-analyzing…</> : <><RefreshCw className="w-4 h-4 mr-2" /> Re-analyze</>}
                      </GlowButton>
                    ) : (
                      <GlowButton onClick={handleAnalyze} disabled={analyzing || extracting || !resumeText.trim()} className="flex-1">
                        {analyzing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing…</> : <><Search className="w-4 h-4 mr-2" /> Analyze Resume</>}
                      </GlowButton>
                    )}
                  </div>
                  {analysisError && (
                    <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                      <span>{analysisError}</span>
                    </p>
                  )}
                </div>

                {/* Results panel */}
                <div>
                  {!result ? (
                    <GlassCard className="p-8 text-center h-full flex flex-col items-center justify-center">
                      <Target className="w-12 h-12 text-muted-foreground mb-4" />
                      <p className="text-foreground font-medium">Upload a resume and click Analyze</p>
                      <p className="text-sm text-muted-foreground mt-1">Get an ATS score and clear recommendations to improve your resume.</p>
                    </GlassCard>
                  ) : (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                      {/* ATS score */}
                      <GlassCard className="p-5">
                        <div className="flex flex-col items-center gap-4">
                          <ScoreRing score={result.ats_readiness_score} label="ATS Readiness" color="#6366f1" />
                          <p className="max-w-xl text-center text-sm text-muted-foreground">
                            {result.score_rationale?.ats_readiness}
                          </p>
                        </div>
                      </GlassCard>

                      <div>
                        <h2 className="font-semibold text-foreground">Changes to Improve Your ATS Score</h2>
                        <p className="text-sm text-muted-foreground mt-1">
                          Review these resume-specific suggestions and update your resume before applying.
                        </p>
                      </div>

                      {/* Accordion sections */}
                      <Accordion type="multiple" defaultValue={['recs']} className="space-y-2">
                        {result.strong_points.length > 0 && (
                          <AccordionItem value="strong" className="glass border border-green-500/20 rounded-xl px-4">
                            <AccordionTrigger className="text-sm font-medium text-green-400">
                              <div className="flex items-center gap-2"><CheckCircle className="w-4 h-4" /> Strong Points ({result.strong_points.length})</div>
                            </AccordionTrigger>
                            <AccordionContent>
                              <ul className="space-y-1 pb-2">
                                {result.strong_points.map((p, i) => <li key={i} className="text-sm text-foreground flex gap-2"><span className="text-green-400 mt-0.5">✓</span>{p}</li>)}
                              </ul>
                            </AccordionContent>
                          </AccordionItem>
                        )}

                        {result.critical_issues.length > 0 && (
                          <AccordionItem value="critical" className="glass border border-red-500/20 rounded-xl px-4">
                            <AccordionTrigger className="text-sm font-medium text-red-400">
                              <div className="flex items-center gap-2"><AlertCircle className="w-4 h-4" /> Critical Issues ({result.critical_issues.length})</div>
                            </AccordionTrigger>
                            <AccordionContent>
                              <ul className="space-y-1 pb-2">
                                {result.critical_issues.map((i, idx) => <li key={idx} className="text-sm text-foreground flex gap-2"><span className="text-red-400 mt-0.5">✗</span>{i}</li>)}
                              </ul>
                            </AccordionContent>
                          </AccordionItem>
                        )}

                        {result.recommendations.length > 0 && (
                          <AccordionItem value="recs" className="glass border border-blue-500/20 rounded-xl px-4">
                            <AccordionTrigger className="text-sm font-medium text-blue-400">
                              <div className="flex items-center gap-2"><Lightbulb className="w-4 h-4" /> Recommendations ({result.recommendations.length})</div>
                            </AccordionTrigger>
                            <AccordionContent>
                              <div className="space-y-2 pb-2">
                                {result.recommendations.map((rec, i) => (
                                  <div key={i} className={`p-3 border rounded-lg text-xs ${PRIORITY_COLORS[rec.priority] || ''}`}>
                                    <div className="flex items-center gap-2 mb-1">
                                      <Badge variant="outline" className={`text-[10px] ${PRIORITY_COLORS[rec.priority]}`}>{rec.priority}</Badge>
                                      <span className="capitalize text-muted-foreground">{rec.category}</span>
                                    </div>
                                    <p className="text-foreground">{rec.message}</p>
                                    {rec.example && <p className="mt-1 italic text-muted-foreground">Example: {rec.example}</p>}
                                  </div>
                                ))}
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                        )}

                      </Accordion>
                    </motion.div>
                  )}
                </div>
              </div>
            </TabsContent>

            {/* ── HISTORY TAB ── */}
            <TabsContent value="history">
              {history.length === 0 ? (
                <GlassCard className="p-8 text-center">
                  <Clock className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-foreground font-medium">No analyses yet</p>
                  <p className="text-sm text-muted-foreground mt-1">Your analysis history will appear here.</p>
                </GlassCard>
              ) : (
                <div className="space-y-3">
                  {history.map((item: { id: string; ats_readiness_score: number | null; resume_file_name: string | null; created_at: string }) => (
                    <GlassCard key={item.id} className="p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-foreground text-sm">{item.resume_file_name || 'Resume'}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {new Date(item.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex gap-4">
                          <div className="text-center">
                            <p className="text-lg font-bold text-primary">{item.ats_readiness_score ?? '--'}</p>
                            <p className="text-xs text-muted-foreground">ATS</p>
                          </div>
                        </div>
                      </div>
                    </GlassCard>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </MainLayout>
    </>
  );
}
