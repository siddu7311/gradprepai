import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Helmet } from 'react-helmet-async';
import {
  Upload, FileText, Brain, Play, Trash2, Archive, Edit2, CheckCircle,
  Plus, ChevronRight, AlertCircle, Clock, BookOpen, Loader2, X,
  RotateCcw, GripVertical, Info
} from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { GlassCard } from '@/components/ui/GlassCard';
import { GlowButton } from '@/components/ui/GlowButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useCustomInterview, type CustomQuestion, type CustomQuestionSet } from '@/hooks/useCustomInterview';
import { extractTextFromFile } from '@/lib/documentParser';
import { useNavigate } from 'react-router-dom';

const ACCEPTED_TYPES = '.pdf,.docx,.txt,.md,.csv,.json';
const MAX_FILE_MB = 20;
const SUPPORTED_FORMATS = ['PDF', 'DOCX', 'TXT', 'MD', 'CSV', 'JSON'];
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.md', '.csv', '.json']);

const difficultyOptions = ['beginner', 'intermediate', 'advanced'];
const languageOptions = ['English', 'Hindi', 'Telugu', 'Tamil', 'Kannada', 'Malayalam', 'Bengali'];
const questionCountOptions = [3, 5, 8, 10, 15, 20];

function QuestionEditor({
  questions,
  onChange,
}: {
  questions: CustomQuestion[];
  onChange: (questions: CustomQuestion[]) => void;
}) {
  const update = (idx: number, field: keyof CustomQuestion, value: string | null) => {
    const next = [...questions];
    (next[idx] as Record<string, unknown>)[field] = value;
    onChange(next);
  };
  const remove = (idx: number) => onChange(questions.filter((_, i) => i !== idx));
  const addBlank = () =>
    onChange([...questions, {
      question_text: '', expected_answer: null, evaluation_criteria: null,
      topic: null, skill_category: null, difficulty: 'intermediate',
      question_type: 'open_ended', source_page: null, display_order: questions.length, tags: [],
    }]);

  return (
    <div className="space-y-3">
      {questions.map((q, idx) => (
        <div key={idx} className="glass border border-glass-border/30 rounded-xl p-4 space-y-2">
          <div className="flex items-start gap-2">
            <GripVertical className="w-4 h-4 text-muted-foreground mt-1 flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground w-6">Q{idx + 1}</span>
                <Textarea
                  value={q.question_text}
                  onChange={(e) => update(idx, 'question_text', e.target.value)}
                  placeholder="Question text…"
                  className="min-h-[60px] text-sm"
                />
                <Button variant="ghost" size="icon" onClick={() => remove(idx)} className="text-destructive flex-shrink-0">
                  <X className="w-4 h-4" />
                </Button>
              </div>
              <Textarea
                value={q.expected_answer || ''}
                onChange={(e) => update(idx, 'expected_answer', e.target.value || null)}
                placeholder="Expected answer (optional)"
                className="min-h-[40px] text-sm text-muted-foreground"
              />
            </div>
          </div>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={addBlank} className="w-full">
        <Plus className="w-4 h-4 mr-2" /> Add Question
      </Button>
    </div>
  );
}

export default function CustomInterview() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { uploading, processing, uploadAndProcess, processExtractedText, updateSet, deleteSet, updateQuestions } = useCustomInterview();

  const [activeTab, setActiveTab] = useState<'my-sets' | 'new' | 'preview'>('my-sets');
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [extractError, setExtractError] = useState('');
  const extractionIdRef = useRef(0);
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formRole, setFormRole] = useState('');
  const [formDifficulty, setFormDifficulty] = useState('intermediate');
  const [formLanguage, setFormLanguage] = useState('English');
  const [formCount, setFormCount] = useState(5);
  const [formGenerate, setFormGenerate] = useState(false);
  const [extractedText, setExtractedText] = useState('');
  const [extractStep, setExtractStep] = useState<'idle' | 'extracting' | 'extracted' | 'processing' | 'done'>('idle');
  const [pendingSetId, setPendingSetId] = useState<string | null>(null);
  const [previewQuestions, setPreviewQuestions] = useState<CustomQuestion[]>([]);
  const [editingSetId, setEditingSetId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [startSetId, setStartSetId] = useState<string | null>(null);

  const { data: questionSets = [], isLoading: setsLoading } = useQuery({
    queryKey: ['custom_question_sets', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('custom_question_sets')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_archived', false)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as CustomQuestionSet[];
    },
    enabled: !!user?.id,
  });

  const { data: archivedSets = [] } = useQuery({
    queryKey: ['custom_question_sets', user?.id, 'archived'],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('custom_question_sets')
        .select('*')
        .eq('user_id', user.id)
        .eq('is_archived', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as CustomQuestionSet[];
    },
    enabled: !!user?.id,
  });

  const { data: adminSets = [] } = useQuery({
    queryKey: ['admin_question_sets'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('custom_question_sets')
        .select('*')
        .eq('is_admin_set', true)
        .eq('is_published', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as CustomQuestionSet[];
    },
  });

  const { data: setQuestions = [] } = useQuery({
    queryKey: ['custom_questions', startSetId],
    queryFn: async () => {
      if (!startSetId) return [];
      const { data, error } = await supabase
        .from('custom_questions')
        .select('*')
        .eq('set_id', startSetId)
        .order('display_order');
      if (error) throw error;
      return data || [];
    },
    enabled: !!startSetId,
  });

  const handleFileChange = async (selectedFile: File) => {
    const extractionId = ++extractionIdRef.current;
    if (
      file &&
      (file.name !== selectedFile.name ||
        file.size !== selectedFile.size ||
        file.lastModified !== selectedFile.lastModified)
    ) {
      setPendingSetId(null);
    }
    const extension = selectedFile.name.slice(selectedFile.name.lastIndexOf('.')).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      setFile(null);
      setExtractedText('');
      setExtractError('Unsupported file format. Upload a PDF, DOCX, TXT, MD, CSV, or JSON file.');
      setExtractStep('idle');
      return;
    }
    if (selectedFile.size > MAX_FILE_MB * 1024 * 1024) {
      setFile(null);
      setExtractedText('');
      setExtractError(`File too large. Maximum size is ${MAX_FILE_MB} MB.`);
      setExtractStep('idle');
      toast.error(`File too large. Maximum size is ${MAX_FILE_MB} MB.`);
      return;
    }
    setFile(selectedFile);
    setExtractStep('extracting');
    setExtractedText('');
    setExtractError('');
    try {
      const text = await extractTextFromFile(selectedFile);
      if (extractionId !== extractionIdRef.current) return;
      if (!text.trim()) {
        throw new Error(
          'No readable text could be extracted. If this is a scanned PDF, try a clearer scan or upload a text-based PDF or a DOCX/TXT file.',
        );
      }
      setExtractedText(text.trim());
      setExtractStep('extracted');
      if (!formTitle) setFormTitle(selectedFile.name.replace(/\.[^/.]+$/, ''));
    } catch (err) {
      if (extractionId !== extractionIdRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to read file';
      setFile(null);
      setExtractedText('');
      setExtractError(message);
      setExtractStep('idle');
      toast.error(message);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) handleFileChange(dropped);
  };

  const handleSubmitUpload = async () => {
    if (!file || extractStep !== 'extracted' || !extractedText.trim()) {
      toast.error(extractError || 'Upload a supported file and wait until text extraction completes.');
      return;
    }
    if (!formTitle.trim()) {
      toast.error('Please enter a title for this question set.');
      return;
    }

    try {
      let setId = pendingSetId;
      if (!setId) {
        const { set_id } = await uploadAndProcess({
          file,
          title: formTitle,
          description: formDescription,
          target_role: formRole || undefined,
          difficulty: formDifficulty,
          language: formLanguage,
          question_count: formCount,
        });
        setId = set_id;
        setPendingSetId(setId);
      }

      setExtractError('');
      setExtractStep('processing');

      const result = await processExtractedText({
        set_id: setId,
        extracted_text: extractedText,
        target_role: formRole || undefined,
        difficulty: formDifficulty,
        language: formLanguage,
        question_count: formCount,
        generate_from_material: formGenerate,
      });

      setPreviewQuestions(result.questions || []);
      setExtractStep('done');
      setActiveTab('preview');
      toast.success(`${result.question_count} questions extracted successfully!`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Processing failed';
      setExtractError(message);
      toast.error(message);
      setExtractStep('extracted');
    }
  };

  const handleSavePreview = async () => {
    if (!pendingSetId) return;
    try {
      await updateQuestions(pendingSetId, previewQuestions);
      toast.success('Question set saved!');
      setActiveTab('my-sets');
      resetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const handleStartInterview = (setId: string) => {
    setStartSetId(setId);
    const set = [...questionSets, ...adminSets].find((questionSet) => questionSet.id === setId);
    navigate('/interview/setup', {
      state: {
        customSetId: setId,
        customSetTitle: set?.title || 'Custom Interview',
        role: set?.target_role || set?.title || 'Custom Interview',
        language: set?.language || 'English',
        difficulty: set?.difficulty || 'intermediate',
        questionCount: set?.question_count || 0,
      },
    });
  };

  const handleRename = async (setId: string) => {
    if (!renameValue.trim()) return;
    try {
      await updateSet(setId, { title: renameValue });
      setEditingSetId(null);
      toast.success('Renamed!');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Rename failed');
    }
  };

  const handleArchive = async (setId: string) => {
    try {
      await updateSet(setId, { is_archived: true });
      toast.success('Question set archived');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Archive failed');
    }
  };

  const handleRestore = async (setId: string) => {
    try {
      await updateSet(setId, { is_archived: false });
      toast.success('Question set restored');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Restore failed');
    }
  };

  const handleDelete = async () => {
    if (!deleteTargetId) return;
    try {
      await deleteSet(deleteTargetId);
      setDeleteTargetId(null);
      toast.success('Question set deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const resetForm = () => {
    extractionIdRef.current += 1;
    setFile(null);
    setFormTitle('');
    setFormDescription('');
    setFormRole('');
    setFormDifficulty('intermediate');
    setFormLanguage('English');
    setFormCount(5);
    setFormGenerate(false);
    setExtractedText('');
    setExtractError('');
    setExtractStep('idle');
    setPendingSetId(null);
    setPreviewQuestions([]);
  };

  if (!user) {
    return (
      <MainLayout>
        <div className="container mx-auto px-4 py-12 text-center">
          <p className="text-muted-foreground">Please sign in to access Custom Interviews.</p>
        </div>
      </MainLayout>
    );
  }

  return (
    <>
      <Helmet>
        <title>My Custom Interviews - GradPrep AI</title>
      </Helmet>
      <MainLayout>
        <div className="container mx-auto px-4 py-8 max-w-5xl">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
            <h1 className="font-display text-3xl font-bold text-foreground mb-2 flex items-center gap-3">
              <Brain className="w-8 h-8 text-primary" />
              My Custom Interviews
            </h1>
            <p className="text-muted-foreground">Upload your own questions or documents and practice with AI voice interviewers.</p>
          </motion.div>

          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
            <TabsList className="mb-6">
              <TabsTrigger value="my-sets">My Question Sets</TabsTrigger>
              <TabsTrigger value="new">
                <Plus className="w-4 h-4 mr-1" /> Upload New
              </TabsTrigger>
              {activeTab === 'preview' && <TabsTrigger value="preview">Preview & Edit</TabsTrigger>}
            </TabsList>

            {/* ── MY SETS TAB ── */}
            <TabsContent value="my-sets">
              {setsLoading ? (
                <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
              ) : questionSets.length === 0 && archivedSets.length === 0 && adminSets.length === 0 ? (
                <GlassCard className="text-center py-12">
                  <BookOpen className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <p className="text-foreground font-medium mb-2">No question sets yet</p>
                  <p className="text-muted-foreground text-sm mb-4">Upload a document to create your first custom question set.</p>
                  <Button onClick={() => setActiveTab('new')} variant="outline">
                    <Upload className="w-4 h-4 mr-2" /> Upload Questions
                  </Button>
                </GlassCard>
              ) : (
                <div className="space-y-6">
                  {questionSets.length > 0 && (
                    <div>
                      <h2 className="text-lg font-semibold text-foreground mb-3">Your Sets</h2>
                      <div className="space-y-3">
                        {questionSets.map((set) => (
                          <GlassCard key={set.id} className="p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                {editingSetId === set.id ? (
                                  <div className="flex gap-2 mb-2">
                                    <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} className="text-sm" autoFocus />
                                    <Button size="sm" onClick={() => handleRename(set.id)}>Save</Button>
                                    <Button size="sm" variant="ghost" onClick={() => setEditingSetId(null)}>Cancel</Button>
                                  </div>
                                ) : (
                                  <h3 className="font-semibold text-foreground truncate">{set.title}</h3>
                                )}
                                <div className="flex flex-wrap gap-2 mt-1">
                                  <Badge variant="outline" className="text-xs">{set.question_count} questions</Badge>
                                  {set.target_role && <Badge variant="secondary" className="text-xs">{set.target_role}</Badge>}
                                  {set.difficulty && <Badge variant="outline" className="text-xs capitalize">{set.difficulty}</Badge>}
                                  <Badge
                                    variant={set.processing_status === 'ready' ? 'default' : 'destructive'}
                                    className="text-xs"
                                  >
                                    {set.processing_status}
                                  </Badge>
                                </div>
                                {set.processing_status === 'error' && set.processing_error && (
                                  <p role="alert" className="mt-2 text-sm text-destructive break-words">
                                    {set.processing_error}
                                  </p>
                                )}
                              </div>
                              <div className="flex gap-1 flex-shrink-0">
                                {set.processing_status === 'ready' && (
                                  <Button size="sm" onClick={() => handleStartInterview(set.id)}>
                                    <Play className="w-4 h-4 mr-1" /> Start
                                  </Button>
                                )}
                                <Button size="icon" variant="ghost" onClick={() => { setEditingSetId(set.id); setRenameValue(set.title); }}>
                                  <Edit2 className="w-4 h-4" />
                                </Button>
                                <Button size="icon" variant="ghost" onClick={() => handleArchive(set.id)}>
                                  <Archive className="w-4 h-4" />
                                </Button>
                                <Button size="icon" variant="ghost" className="text-destructive" onClick={() => setDeleteTargetId(set.id)}>
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            </div>
                          </GlassCard>
                        ))}
                      </div>
                    </div>
                  )}
                  {archivedSets.length > 0 && (
                    <div>
                      <h2 className="text-lg font-semibold text-foreground mb-3">Archived Sets</h2>
                      <div className="space-y-3">
                        {archivedSets.map((set) => (
                          <GlassCard key={set.id} className="p-4">
                            <div className="flex items-center justify-between gap-4">
                              <div className="min-w-0">
                                <h3 className="font-semibold text-foreground truncate">{set.title}</h3>
                                <div className="flex flex-wrap gap-2 mt-1">
                                  <Badge variant="outline" className="text-xs">{set.question_count} questions</Badge>
                                  {set.target_role && <Badge variant="secondary" className="text-xs">{set.target_role}</Badge>}
                                  {set.difficulty && <Badge variant="outline" className="text-xs capitalize">{set.difficulty}</Badge>}
                                  <Badge variant="outline" className="text-xs">Archived</Badge>
                                </div>
                              </div>
                              <Button size="sm" variant="outline" onClick={() => handleRestore(set.id)}>
                                <RotateCcw className="w-4 h-4 mr-1" /> Restore
                              </Button>
                            </div>
                          </GlassCard>
                        ))}
                      </div>
                    </div>
                  )}
                  {adminSets.length > 0 && (
                    <div>
                      <h2 className="text-lg font-semibold text-foreground mb-3">Shared by GradPrep AI</h2>
                      <div className="space-y-3">
                        {adminSets.map((set) => (
                          <GlassCard key={set.id} className="p-4 border-primary/20">
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <h3 className="font-semibold text-foreground">{set.title}</h3>
                                <div className="flex gap-2 mt-1">
                                  <Badge variant="outline" className="text-xs">{set.question_count} questions</Badge>
                                  {set.target_role && <Badge variant="secondary" className="text-xs">{set.target_role}</Badge>}
                                  <Badge className="text-xs bg-primary/20 text-primary">Admin Set</Badge>
                                </div>
                              </div>
                              <Button size="sm" onClick={() => handleStartInterview(set.id)}>
                                <Play className="w-4 h-4 mr-1" /> Start
                              </Button>
                            </div>
                          </GlassCard>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </TabsContent>

            {/* ── UPLOAD TAB ── */}
            <TabsContent value="new">
              <GlassCard className="p-6 space-y-6">
                {/* File upload area */}
                <div>
                  <Label className="text-sm font-medium mb-2 block">Upload Document</Label>
                  <div
                    className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${
                      dragOver ? 'border-primary bg-primary/5' : 'border-border/50 hover:border-primary/50'
                    }`}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => document.getElementById('file-input')?.click()}
                  >
                    <input
                      id="file-input"
                      type="file"
                      accept={ACCEPTED_TYPES}
                      className="hidden"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) handleFileChange(f);
                      }}
                    />
                    {extractStep === 'extracting' ? (
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-8 h-8 animate-spin text-primary" />
                        <p className="text-sm text-muted-foreground">Reading file…</p>
                      </div>
                    ) : file ? (
                      <div className="flex flex-col items-center gap-2">
                        <CheckCircle className="w-8 h-8 text-green-500" />
                        <p className="text-sm font-medium text-foreground">{file.name}</p>
                        <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB · Click to change</p>
                      </div>
                    ) : (
                      <>
                        <Upload className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                        <p className="text-foreground font-medium">Drag & drop or click to upload</p>
                        <p className="text-sm text-muted-foreground mt-1">
                          Supported: {SUPPORTED_FORMATS.join(', ')} · Max {MAX_FILE_MB} MB
                        </p>
                      </>
                    )}
                  </div>
                  {extractStep === 'extracted' && (
                    <div className="mt-2 p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-600 flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 flex-shrink-0" />
                      Text extracted ({extractedText.length.toLocaleString()} chars). Configure options below.
                    </div>
                  )}
                  {extractError && (
                    <div role="alert" className="mt-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      {extractError}
                    </div>
                  )}
                </div>

                {/* Form fields */}
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label>Question Set Title *</Label>
                    <Input value={formTitle} onChange={(e) => setFormTitle(e.target.value)} placeholder="e.g. System Design Questions" className="mt-1" />
                  </div>
                  <div>
                    <Label>Target Role (optional)</Label>
                    <Input value={formRole} onChange={(e) => setFormRole(e.target.value)} placeholder="e.g. Backend Developer" className="mt-1" />
                  </div>
                  <div>
                    <Label>Difficulty</Label>
                    <Select value={formDifficulty} onValueChange={setFormDifficulty}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {difficultyOptions.map(d => <SelectItem key={d} value={d} className="capitalize">{d}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Language</Label>
                    <Select value={formLanguage} onValueChange={setFormLanguage}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {languageOptions.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Number of Questions</Label>
                    <Select value={String(formCount)} onValueChange={(v) => setFormCount(Number(v))}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {questionCountOptions.map(c => <SelectItem key={c} value={String(c)}>{c} questions</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Extraction Mode</Label>
                    <Select value={formGenerate ? 'generate' : 'extract'} onValueChange={(v) => setFormGenerate(v === 'generate')}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="extract">Extract existing questions</SelectItem>
                        <SelectItem value="generate">Generate from content</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Label>Description (optional)</Label>
                  <Textarea value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="Brief description of this question set…" className="mt-1" />
                </div>

                <div className="flex gap-3">
                  <GlowButton
                    onClick={handleSubmitUpload}
                    disabled={!file || extractStep !== 'extracted' || uploading || processing}
                    className="flex-1"
                  >
                    {(uploading || processing || extractStep === 'processing') ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing…</>
                    ) : (
                      <><Brain className="w-4 h-4 mr-2" /> {pendingSetId ? 'Retry Processing' : 'Extract Questions'}</>
                    )}
                  </GlowButton>
                  <Button variant="ghost" onClick={resetForm}>Reset</Button>
                </div>

                <div className="flex items-start gap-2 p-3 bg-muted/30 rounded-lg">
                  <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    After extraction you can preview, edit, reorder and add questions before saving.
                    The original file is stored privately and not shared.
                  </p>
                </div>
              </GlassCard>
            </TabsContent>

            {/* ── PREVIEW TAB ── */}
            <TabsContent value="preview">
              <GlassCard className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-foreground">
                    Preview & Edit — {previewQuestions.length} Questions
                  </h2>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => { setExtractStep('extracted'); setActiveTab('new'); }}>
                      <RotateCcw className="w-4 h-4 mr-1" /> Re-process
                    </Button>
                    <GlowButton size="sm" onClick={handleSavePreview} disabled={previewQuestions.length === 0}>
                      <CheckCircle className="w-4 h-4 mr-1" /> Save Set
                    </GlowButton>
                  </div>
                </div>
                <QuestionEditor questions={previewQuestions} onChange={setPreviewQuestions} />
              </GlassCard>
            </TabsContent>
          </Tabs>
        </div>

        {/* Delete confirmation dialog */}
        <AlertDialog open={!!deleteTargetId} onOpenChange={() => setDeleteTargetId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Question Set?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete the question set and all its questions. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive hover:bg-destructive/90" onClick={handleDelete}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </MainLayout>
    </>
  );
}
