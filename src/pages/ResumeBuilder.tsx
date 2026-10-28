import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Helmet } from 'react-helmet-async';
import { FileText, Upload, Sparkles, Target, ChevronRight, AlertCircle, CheckCircle, TrendingUp, Lightbulb, BookOpen, Download, Palette, X, FileUp, Search, Loader2, Award } from 'lucide-react';
import { Navbar } from '@/components/layout/Navbar';
import { Footer } from '@/components/layout/Footer';
import { AnimatedBackground } from '@/components/ui/AnimatedBackground';
import { GlassCard } from '@/components/ui/GlassCard';
import { GlowButton } from '@/components/ui/GlowButton';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { templates, templateInfo, TemplateType } from '@/components/resume/ResumeTemplates';
import { extractTextFromFile, isValidResumeFile, getFileIcon } from '@/lib/documentParser';
import html2pdf from 'html2pdf.js';
import { useAtsAnalyzer, type AtsAnalysisResult } from '@/hooks/useAtsAnalyzer';
import { getSupabaseFunctionErrorMessage } from '@/lib/supabaseFunctionError';

interface ResumeAnalysis {
  improvedResume: {
    contactInfo: {
      name: string;
      email: string;
      phone: string;
      linkedin: string;
      github: string;
      portfolio: string;
    };
    summary: string;
    skills: {
      technical: string[];
      soft: string[];
      tools: string[];
    };
    experience: Array<{
      title: string;
      company: string;
      duration: string;
      bullets: string[];
    }>;
    projects: Array<{
      name: string;
      description: string;
      technologies: string[];
      bullets: string[];
    }>;
    education: Array<{
      degree: string;
      institution: string;
      year: string;
      gpa: string;
    }>;
    certifications: string[];
  };
  atsScore: number;
  recruiterReadinessScore: number;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
  suggestedSkills: string[];
}

const roleOptions = [
  'Software Developer',
  'Frontend Developer',
  'Backend Developer',
  'Full-Stack Developer',
  'Data Scientist',
  'Data Analyst',
  'Cloud Engineer',
  'DevOps Engineer',
  'Cybersecurity Analyst',
  'AI/ML Engineer',
  'QA Engineer',
  'Mobile Developer',
];

const PRIORITY_COLORS: Record<string, string> = {
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
          <circle cx="44" cy="44" r={radius} fill="none" strokeWidth="8"
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

export default function ResumeBuilder() {
  const { user } = useAuth();
  // ── Resume Builder state ──
  const [resumeContent, setResumeContent] = useState('');
  const [targetRole, setTargetRole] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateType>('modern');
  const [analysis, setAnalysis] = useState<ResumeAnalysis | null>(null);
  const pdfRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── ATS Analyzer state ──
  const { analyzing: atsAnalyzing, error: atsAnalysisError, analyze: atsAnalyze } = useAtsAnalyzer();
  const [atsFile, setAtsFile] = useState<File | null>(null);
  const [atsResumeText, setAtsResumeText] = useState('');
  const [atsExtracting, setAtsExtracting] = useState(false);
  const [atsExtractError, setAtsExtractError] = useState('');
  const [atsDragOver, setAtsDragOver] = useState(false);
  const atsFileRef = useRef<HTMLInputElement>(null);
  const [atsResult, setAtsResult] = useState<AtsAnalysisResult | null>(null);

  const handleFileUpload = useCallback(async (file: File) => {
    if (!isValidResumeFile(file)) {
      toast.error('Please upload a PDF, DOCX, or TXT file');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error('File size must be less than 10MB');
      return;
    }

    setIsParsing(true);
    setUploadedFile(file);

    try {
      const text = await extractTextFromFile(file);
      setResumeContent(text);
      toast.success(`Successfully extracted text from ${file.name}`);
    } catch (error) {
      console.error('File parsing error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to parse file');
      setUploadedFile(null);
    } finally {
      setIsParsing(false);
    }
  }, []);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileUpload(file);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileUpload(file);
    }
  }, [handleFileUpload]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const clearUploadedFile = () => {
    setUploadedFile(null);
    setResumeContent('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleAnalyze = async () => {
    if (!resumeContent.trim()) {
      toast.error('Please paste your resume content');
      return;
    }

    setIsAnalyzing(true);
    setAnalysis(null);

    try {
      const { data, error } = await supabase.functions.invoke('analyze-resume', {
        body: { resumeContent, targetRole: targetRole || undefined },
      });

      if (error) throw new Error(await getSupabaseFunctionErrorMessage(error));
      if (data?.error) throw new Error(data.error);
      if (!data?.improvedResume) throw new Error('Resume analysis returned an incomplete result. Please try again.');

      setAnalysis(data);
      toast.success('Resume analysis complete!');
    } catch (error) {
      console.error('Analysis error:', error);
      toast.error(await getSupabaseFunctionErrorMessage(error));
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleExportPDF = async () => {
    if (!analysis || !pdfRef.current) return;

    setIsExporting(true);
    try {
      const element = pdfRef.current;
      const templateName = templateInfo[selectedTemplate].name;
      const opt = {
        margin: 0,
        filename: `${analysis.improvedResume.contactInfo.name || 'resume'}_${templateName}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      };
      
      await html2pdf().set(opt).from(element).save();
      toast.success(`Resume exported with ${templateName} template!`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export resume. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return 'text-success';
    if (score >= 60) return 'text-warning';
    return 'text-destructive';
  };

  const getScoreGradient = (score: number) => {
    if (score >= 80) return 'from-success/20 to-success/5';
    if (score >= 60) return 'from-warning/20 to-warning/5';
    return 'from-destructive/20 to-destructive/5';
  };

  // ── ATS handlers ──
  const handleAtsFile = useCallback(async (file: File) => {
    setAtsFile(null);
    setAtsResumeText('');
    setAtsResult(null);
    setAtsExtractError('');
    if (!isValidResumeFile(file)) {
      setAtsExtractError('Unsupported format. Please upload a PDF, DOCX, or TXT file.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setAtsExtractError('File too large. Maximum size is 10 MB.');
      return;
    }
    setAtsExtracting(true);
    try {
      const text = await extractTextFromFile(file);
      if (!text.trim()) {
        throw new Error(
          'No readable text could be extracted. If this is a scanned PDF, try a clearer scan or upload a text-based PDF or DOCX/TXT resume.',
        );
      }
      setAtsFile(file);
      setAtsResumeText(text.trim());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read file';
      setAtsExtractError(message);
      toast.error(message);
    } finally {
      setAtsExtracting(false);
    }
  }, []);

  const handleAtsAnalyze = async () => {
    if (!atsResumeText.trim()) { toast.error('Please upload a resume first.'); return; }
    try {
      const res = await atsAnalyze({
        resume_text: atsResumeText,
        resume_file_name: atsFile?.name,
      });
      setAtsResult(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
    }
  };

  return (
    <>
      <Helmet>
        <title>Resume Builder | GradPrep AI</title>
        <meta name="description" content="Build an ATS-optimized, recruiter-approved resume with AI-powered analysis and suggestions." />
      </Helmet>

      <div className="min-h-screen bg-background relative overflow-hidden">
        <AnimatedBackground />
        <Navbar />

        <main className="relative z-10 pt-24 pb-20">
          <div className="container mx-auto px-4 max-w-7xl">
            {/* Header */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-center mb-8"
            >
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass border border-primary/30 mb-6">
                <Sparkles className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-primary">AI-Powered Resume Tools</span>
              </div>
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4">
                Build Your <span className="gradient-text">Winning Resume</span>
              </h1>
              <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
                Build an ATS-optimized resume or analyze an existing one against a job description.
              </p>
            </motion.div>

            {/* Top-level module tabs */}
            <Tabs defaultValue="builder" className="w-full">
              <TabsList className="mb-8 mx-auto flex w-fit">
                <TabsTrigger value="builder" className="gap-2">
                  <FileText className="w-4 h-4" /> Resume Builder
                </TabsTrigger>
                <TabsTrigger value="ats" className="gap-2">
                  <Target className="w-4 h-4" /> ATS Analyzer
                </TabsTrigger>
              </TabsList>

              {/* ── RESUME BUILDER TAB ── */}
              <TabsContent value="builder">
            <div className="grid lg:grid-cols-2 gap-8">
              {/* Input Section */}
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 }}
              >
                <GlassCard hover={false} className="h-full">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <FileText className="w-5 h-5 text-primary" />
                    </div>
                    <h2 className="font-display text-xl font-semibold">Your Resume</h2>
                  </div>

                  <div className="space-y-6">
                    <div className="space-y-2">
                      <Label htmlFor="targetRole">Target Role (Optional)</Label>
                      <div className="relative">
                        <Target className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                          id="targetRole"
                          placeholder="e.g., Software Developer, Data Scientist"
                          value={targetRole}
                          onChange={(e) => setTargetRole(e.target.value)}
                          className="pl-10 bg-background/50 border-border/50 focus:border-primary"
                          list="roles"
                        />
                        <datalist id="roles">
                          {roleOptions.map((role) => (
                            <option key={role} value={role} />
                          ))}
                        </datalist>
                      </div>
                    </div>

                    {/* File Upload Area */}
                    <div className="space-y-2">
                      <Label>Upload Resume File</Label>
                      <div
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                        className={`relative border-2 border-dashed rounded-lg p-6 text-center transition-all ${
                          isParsing 
                            ? 'border-primary bg-primary/5' 
                            : 'border-border/50 hover:border-primary/50 hover:bg-primary/5'
                        }`}
                      >
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".pdf,.docx,.doc,.txt"
                          onChange={handleFileInputChange}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                          disabled={isParsing}
                        />
                        
                        {isParsing ? (
                          <div className="flex flex-col items-center gap-2">
                            <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                            <p className="text-sm text-muted-foreground">Extracting text...</p>
                          </div>
                        ) : uploadedFile ? (
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <span className="text-2xl">{getFileIcon(uploadedFile.name)}</span>
                              <div className="text-left">
                                <p className="font-medium text-sm">{uploadedFile.name}</p>
                                <p className="text-xs text-muted-foreground">
                                  {(uploadedFile.size / 1024).toFixed(1)} KB
                                </p>
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                clearUploadedFile();
                              }}
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center gap-2">
                            <FileUp className="w-8 h-8 text-muted-foreground" />
                            <div>
                              <p className="text-sm font-medium">Drop your resume here or click to upload</p>
                              <p className="text-xs text-muted-foreground">Supports PDF, DOCX, DOC, TXT (max 10MB)</p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="relative flex items-center gap-4">
                      <div className="flex-1 h-px bg-border/50" />
                      <span className="text-xs text-muted-foreground">or paste manually</span>
                      <div className="flex-1 h-px bg-border/50" />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="resumeContent">Resume Content</Label>
                      <Textarea
                        id="resumeContent"
                        placeholder="Paste your entire resume text here... Include all sections like contact info, education, experience, skills, projects, certifications, etc."
                        value={resumeContent}
                        onChange={(e) => {
                          setResumeContent(e.target.value);
                          if (uploadedFile) setUploadedFile(null);
                        }}
                        className="min-h-[300px] bg-background/50 border-border/50 focus:border-primary resize-none"
                      />
                      <p className="text-xs text-muted-foreground">
                        {resumeContent.length} characters
                      </p>
                    </div>

                    <GlowButton
                      onClick={handleAnalyze}
                      disabled={isAnalyzing || !resumeContent.trim()}
                      className="w-full"
                    >
                      {isAnalyzing ? (
                        <>
                          <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin mr-2" />
                          Building Resume...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4 mr-2" />
                          Build Resume
                          <ChevronRight className="w-4 h-4 ml-2" />
                        </>
                      )}
                    </GlowButton>
                  </div>
                </GlassCard>
              </motion.div>

              {/* Results Section */}
              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 }}
                className="space-y-6"
              >
                <AnimatePresence mode="wait">
                  {!analysis && !isAnalyzing && (
                    <motion.div
                      key="placeholder"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      <GlassCard hover={false} className="h-full min-h-[500px] flex items-center justify-center">
                        <div className="text-center">
                          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                            <Upload className="w-10 h-10 text-primary/50" />
                          </div>
                          <h3 className="font-display text-lg font-medium mb-2 text-muted-foreground">
                            Your Resume Preview Will Appear Here
                          </h3>
                          <p className="text-sm text-muted-foreground/70 max-w-sm">
                            Paste your resume content and click "Build Resume" to create an optimized resume with AI-powered improvements.
                          </p>
                        </div>
                      </GlassCard>
                    </motion.div>
                  )}

                  {isAnalyzing && (
                    <motion.div
                      key="loading"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      <GlassCard hover={false} className="h-full min-h-[500px] flex items-center justify-center">
                        <div className="text-center">
                          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4 animate-pulse">
                            <Sparkles className="w-10 h-10 text-primary animate-spin" />
                          </div>
                          <h3 className="font-display text-lg font-medium mb-2">
                            Building Your Resume...
                          </h3>
                          <p className="text-sm text-muted-foreground max-w-sm">
                            Our AI is improving your resume content and preparing your formatted preview.
                          </p>
                        </div>
                      </GlassCard>
                    </motion.div>
                  )}

                  {analysis && (
                    <motion.div
                      key="results"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      className="space-y-6"
                    >
                      {/* Scores */}
                      <div className="grid grid-cols-2 gap-4">
                        <GlassCard hover={false} className={`bg-gradient-to-br ${getScoreGradient(analysis.atsScore)}`}>
                          <div className="text-center">
                            <p className="text-sm text-muted-foreground mb-2">ATS Score</p>
                            <p className={`font-display text-4xl font-bold ${getScoreColor(analysis.atsScore)}`}>
                              {analysis.atsScore}%
                            </p>
                            <Progress value={analysis.atsScore} className="mt-3 h-2" />
                          </div>
                        </GlassCard>
                        <GlassCard hover={false} className={`bg-gradient-to-br ${getScoreGradient(analysis.recruiterReadinessScore)}`}>
                          <div className="text-center">
                            <p className="text-sm text-muted-foreground mb-2">Recruiter Ready</p>
                            <p className={`font-display text-4xl font-bold ${getScoreColor(analysis.recruiterReadinessScore)}`}>
                              {analysis.recruiterReadinessScore}%
                            </p>
                            <Progress value={analysis.recruiterReadinessScore} className="mt-3 h-2" />
                          </div>
                        </GlassCard>
                      </div>

                      {/* Tabs for detailed analysis */}
                      <GlassCard hover={false}>
                        <Tabs defaultValue="strengths" className="w-full">
                          <TabsList className="grid grid-cols-4 mb-4">
                            <TabsTrigger value="strengths" className="text-xs sm:text-sm">
                              <CheckCircle className="w-3 h-3 mr-1 hidden sm:inline" />
                              Strengths
                            </TabsTrigger>
                            <TabsTrigger value="weaknesses" className="text-xs sm:text-sm">
                              <AlertCircle className="w-3 h-3 mr-1 hidden sm:inline" />
                              Weaknesses
                            </TabsTrigger>
                            <TabsTrigger value="improvements" className="text-xs sm:text-sm">
                              <TrendingUp className="w-3 h-3 mr-1 hidden sm:inline" />
                              Improve
                            </TabsTrigger>
                            <TabsTrigger value="skills" className="text-xs sm:text-sm">
                              <Lightbulb className="w-3 h-3 mr-1 hidden sm:inline" />
                              Learn
                            </TabsTrigger>
                          </TabsList>

                          <TabsContent value="strengths" className="space-y-2">
                            {analysis.strengths.map((strength, i) => (
                              <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-success/5 border border-success/20">
                                <CheckCircle className="w-4 h-4 text-success mt-0.5 flex-shrink-0" />
                                <p className="text-sm">{strength}</p>
                              </div>
                            ))}
                          </TabsContent>

                          <TabsContent value="weaknesses" className="space-y-2">
                            {analysis.weaknesses.map((weakness, i) => (
                              <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-destructive/5 border border-destructive/20">
                                <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                                <p className="text-sm">{weakness}</p>
                              </div>
                            ))}
                          </TabsContent>

                          <TabsContent value="improvements" className="space-y-2">
                            {analysis.improvements.map((improvement, i) => (
                              <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-primary/5 border border-primary/20">
                                <TrendingUp className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                                <p className="text-sm">{improvement}</p>
                              </div>
                            ))}
                          </TabsContent>

                          <TabsContent value="skills" className="space-y-3">
                            <p className="text-sm text-muted-foreground mb-2">Skills to boost your profile:</p>
                            <div className="flex flex-wrap gap-2">
                              {analysis.suggestedSkills.map((skill, i) => (
                                <Badge key={i} variant="outline" className="bg-secondary/10 border-secondary/30 text-secondary">
                                  <BookOpen className="w-3 h-3 mr-1" />
                                  {skill}
                                </Badge>
                              ))}
                            </div>
                          </TabsContent>
                        </Tabs>
                      </GlassCard>

                      {/* Template Selector with Live Preview */}
                      <GlassCard hover={false}>
                        <div className="flex items-center gap-3 mb-4">
                          <div className="p-2 rounded-lg bg-primary/10">
                            <Palette className="w-5 h-5 text-primary" />
                          </div>
                          <h3 className="font-display text-lg font-semibold">Choose Template</h3>
                        </div>
                        
                        {/* Template Options */}
                        <div className="grid grid-cols-3 gap-3 mb-6">
                          {(Object.keys(templates) as TemplateType[]).map((key) => (
                            <button
                              key={key}
                              onClick={() => setSelectedTemplate(key)}
                              className={`p-3 rounded-lg border-2 transition-all text-left ${
                                selectedTemplate === key
                                  ? 'border-primary bg-primary/10 shadow-lg shadow-primary/20'
                                  : 'border-border/50 hover:border-primary/50 bg-background/30'
                              }`}
                            >
                              <div className="text-2xl mb-1">{templateInfo[key].preview}</div>
                              <p className="font-medium text-sm">{templateInfo[key].name}</p>
                              <p className="text-xs text-muted-foreground">{templateInfo[key].description}</p>
                            </button>
                          ))}
                        </div>

                        {/* Live Preview */}
                        <div className="border-t border-border/30 pt-4">
                          <div className="flex items-center justify-between mb-3">
                            <p className="text-sm font-medium text-muted-foreground">
                              Live Preview: <span className="text-primary">{templateInfo[selectedTemplate].name}</span>
                            </p>
                            <Badge variant="outline" className="text-xs">
                              A4 Format
                            </Badge>
                          </div>
                          <div className="bg-muted/30 rounded-lg p-3 overflow-hidden">
                            <div 
                              className="mx-auto bg-white rounded shadow-xl overflow-hidden"
                              style={{
                                width: '100%',
                                maxWidth: '300px',
                                aspectRatio: '210 / 297',
                              }}
                            >
                              <div 
                                style={{
                                  transform: 'scale(0.38)',
                                  transformOrigin: 'top left',
                                  width: '263%',
                                  height: '263%',
                                }}
                              >
                                {(() => {
                                  const PreviewTemplate = templates[selectedTemplate];
                                  return <PreviewTemplate resume={analysis.improvedResume} />;
                                })()}
                              </div>
                            </div>
                          </div>
                        </div>
                      </GlassCard>

                      {/* Improved Resume Preview */}
                      <GlassCard hover={false}>
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-secondary/10">
                              <FileText className="w-5 h-5 text-secondary" />
                            </div>
                            <h3 className="font-display text-lg font-semibold">Optimized Resume</h3>
                          </div>
                          <Button
                            onClick={handleExportPDF}
                            disabled={isExporting}
                            variant="outline"
                            size="sm"
                            className="border-primary/30 hover:bg-primary/10"
                          >
                            {isExporting ? (
                              <>
                                <div className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin mr-2" />
                                Exporting...
                              </>
                            ) : (
                              <>
                                <Download className="w-4 h-4 mr-2" />
                                Export {templateInfo[selectedTemplate].name}
                              </>
                            )}
                          </Button>
                        </div>
                        
                        <div className="space-y-6 text-sm">
                          {/* Contact Info */}
                          {analysis.improvedResume.contactInfo.name && (
                            <div className="text-center border-b border-border/30 pb-4">
                              <h4 className="font-display text-xl font-bold gradient-text">
                                {analysis.improvedResume.contactInfo.name}
                              </h4>
                              <div className="flex flex-wrap justify-center gap-2 mt-2 text-muted-foreground text-xs">
                                {analysis.improvedResume.contactInfo.email && (
                                  <span>{analysis.improvedResume.contactInfo.email}</span>
                                )}
                                {analysis.improvedResume.contactInfo.phone && (
                                  <span>• {analysis.improvedResume.contactInfo.phone}</span>
                                )}
                                {analysis.improvedResume.contactInfo.linkedin && (
                                  <span>• {analysis.improvedResume.contactInfo.linkedin}</span>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Summary */}
                          {analysis.improvedResume.summary && (
                            <div>
                              <h5 className="font-display font-semibold text-primary mb-2">Professional Summary</h5>
                              <p className="text-muted-foreground">{analysis.improvedResume.summary}</p>
                            </div>
                          )}

                          {/* Skills */}
                          {(analysis.improvedResume.skills.technical.length > 0 || 
                            analysis.improvedResume.skills.tools.length > 0) && (
                            <div>
                              <h5 className="font-display font-semibold text-primary mb-2">Skills</h5>
                              <div className="flex flex-wrap gap-1.5">
                                {analysis.improvedResume.skills.technical.map((skill, i) => (
                                  <Badge key={i} variant="secondary" className="text-xs">
                                    {skill}
                                  </Badge>
                                ))}
                                {analysis.improvedResume.skills.tools.map((tool, i) => (
                                  <Badge key={i} variant="outline" className="text-xs">
                                    {tool}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Experience */}
                          {analysis.improvedResume.experience.length > 0 && (
                            <div>
                              <h5 className="font-display font-semibold text-primary mb-2">Experience</h5>
                              {analysis.improvedResume.experience.map((exp, i) => (
                                <div key={i} className="mb-3 last:mb-0">
                                  <div className="flex justify-between items-start">
                                    <div>
                                      <p className="font-medium">{exp.title}</p>
                                      <p className="text-muted-foreground text-xs">{exp.company}</p>
                                    </div>
                                    <span className="text-xs text-muted-foreground">{exp.duration}</span>
                                  </div>
                                  <ul className="mt-1 space-y-1">
                                    {exp.bullets.map((bullet, j) => (
                                      <li key={j} className="text-xs text-muted-foreground flex items-start gap-2">
                                        <span className="text-primary mt-1">•</span>
                                        {bullet}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Projects */}
                          {analysis.improvedResume.projects.length > 0 && (
                            <div>
                              <h5 className="font-display font-semibold text-primary mb-2">Projects</h5>
                              {analysis.improvedResume.projects.map((project, i) => (
                                <div key={i} className="mb-3 last:mb-0">
                                  <p className="font-medium">{project.name}</p>
                                  <p className="text-xs text-muted-foreground">{project.description}</p>
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {project.technologies.map((tech, j) => (
                                      <Badge key={j} variant="outline" className="text-[10px] px-1.5 py-0">
                                        {tech}
                                      </Badge>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Education */}
                          {analysis.improvedResume.education.length > 0 && (
                            <div>
                              <h5 className="font-display font-semibold text-primary mb-2">Education</h5>
                              {analysis.improvedResume.education.map((edu, i) => (
                                <div key={i} className="flex justify-between items-start">
                                  <div>
                                    <p className="font-medium">{edu.degree}</p>
                                    <p className="text-xs text-muted-foreground">{edu.institution}</p>
                                  </div>
                                  <div className="text-right text-xs text-muted-foreground">
                                    <p>{edu.year}</p>
                                    {edu.gpa && <p>GPA: {edu.gpa}</p>}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </GlassCard>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </div>
              </TabsContent>

              {/* ── ATS ANALYZER TAB ── */}
              <TabsContent value="ats">
                <div className="grid lg:grid-cols-2 gap-8">
                  {/* Left: inputs */}
                  <div className="space-y-4">
                    <GlassCard hover={false} className="p-5 space-y-4">
                      <h2 className="font-display text-lg font-semibold flex items-center gap-2">
                        <Upload className="w-5 h-5 text-primary" /> Upload Your Resume
                      </h2>
                      <div
                        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${atsDragOver ? 'border-primary bg-primary/5' : 'border-border/50 hover:border-primary/50'}`}
                        onDragOver={(e) => { e.preventDefault(); setAtsDragOver(true); }}
                        onDragLeave={() => setAtsDragOver(false)}
                        onDrop={(e) => { e.preventDefault(); setAtsDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleAtsFile(f); }}
                        onClick={() => atsFileRef.current?.click()}
                      >
                        <input ref={atsFileRef} type="file" accept=".pdf,.docx,.doc,.txt" className="hidden"
                          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleAtsFile(f); }} />
                        {atsExtracting ? (
                          <div className="flex flex-col items-center gap-2">
                            <Loader2 className="w-8 h-8 animate-spin text-primary" />
                            <p className="text-sm text-muted-foreground">Extracting text…</p>
                          </div>
                        ) : atsFile ? (
                          <div className="flex items-center justify-center gap-3">
                            <FileText className="w-6 h-6 text-green-500" />
                            <span className="text-sm font-medium">{atsFile.name}</span>
                            <button onClick={(e) => { e.stopPropagation(); setAtsFile(null); setAtsResumeText(''); setAtsResult(null); setAtsExtractError(''); }}>
                              <X className="w-4 h-4 text-muted-foreground hover:text-foreground" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <Upload className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                            <p className="text-sm font-medium text-foreground">Drop PDF, DOCX, or TXT</p>
                            <p className="text-xs text-muted-foreground mt-1">Max 10 MB</p>
                          </>
                        )}
                      </div>
                    </GlassCard>

                    {atsExtractError && (
                      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        <span>{atsExtractError}</span>
                      </p>
                    )}
                    {!user && (
                      <p role="status" className="text-sm text-muted-foreground">
                        Sign in to analyze your resume. <Link to="/signin" className="text-primary underline">Sign in</Link>
                      </p>
                    )}
                    <GlowButton onClick={handleAtsAnalyze} disabled={atsAnalyzing || atsExtracting || !atsResumeText.trim() || !user} className="w-full">
                      {atsAnalyzing ? (
                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing…</>
                      ) : (
                        <><Search className="w-4 h-4 mr-2" /> Analyze Resume</>
                      )}
                    </GlowButton>
                    {atsAnalysisError && (
                      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        <span>{atsAnalysisError}</span>
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground text-center">
                      Scores are GradPrep AI estimates, not actual ATS results.
                    </p>
                  </div>

                  {/* Right: results */}
                  <div>
                    {!atsResult ? (
                      <GlassCard hover={false} className="min-h-[400px] flex items-center justify-center p-8 text-center">
                        <div>
                          <Target className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                          <p className="font-medium text-foreground">Upload a resume and click Analyze</p>
                          <p className="text-sm text-muted-foreground mt-1">Get an ATS score and specific suggestions to improve your resume.</p>
                        </div>
                      </GlassCard>
                    ) : (
                      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                        {/* ATS score */}
                        <GlassCard hover={false} className="p-5">
                          <div className="flex flex-col items-center gap-4">
                            <ScoreRing score={atsResult.ats_readiness_score} label="ATS Readiness" color="#6366f1" />
                            <p className="max-w-xl text-center text-sm text-muted-foreground">
                              {atsResult.score_rationale?.ats_readiness}
                            </p>
                          </div>
                        </GlassCard>

                        <div>
                          <h3 className="font-semibold text-foreground">Changes to Improve Your ATS Score</h3>
                          <p className="text-sm text-muted-foreground mt-1">
                            Use these resume-specific suggestions to make improvements before applying.
                          </p>
                        </div>

                        <Accordion type="multiple" defaultValue={['recs']} className="space-y-2">
                          {atsResult.strong_points?.length > 0 && (
                            <AccordionItem value="strong" className="glass border border-green-500/20 rounded-xl px-4">
                              <AccordionTrigger className="text-sm font-medium text-green-400">
                                <div className="flex items-center gap-2"><CheckCircle className="w-4 h-4" /> Strong Points ({atsResult.strong_points.length})</div>
                              </AccordionTrigger>
                              <AccordionContent>
                                <ul className="space-y-1 pb-2">
                                  {atsResult.strong_points.map((p, i) => <li key={i} className="text-sm text-foreground flex gap-2"><span className="text-green-400">✓</span>{p}</li>)}
                                </ul>
                              </AccordionContent>
                            </AccordionItem>
                          )}
                          {atsResult.critical_issues?.length > 0 && (
                            <AccordionItem value="critical" className="glass border border-red-500/20 rounded-xl px-4">
                              <AccordionTrigger className="text-sm font-medium text-red-400">
                                <div className="flex items-center gap-2"><AlertCircle className="w-4 h-4" /> Critical Issues ({atsResult.critical_issues.length})</div>
                              </AccordionTrigger>
                              <AccordionContent>
                                <ul className="space-y-1 pb-2">
                                  {atsResult.critical_issues.map((i, idx) => <li key={idx} className="text-sm text-foreground flex gap-2"><span className="text-red-400">✗</span>{i}</li>)}
                                </ul>
                              </AccordionContent>
                            </AccordionItem>
                          )}
                          {atsResult.recommendations?.length > 0 && (
                            <AccordionItem value="recs" className="glass border border-blue-500/20 rounded-xl px-4">
                              <AccordionTrigger className="text-sm font-medium text-blue-400">
                                <div className="flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Recommendations ({atsResult.recommendations.length})</div>
                              </AccordionTrigger>
                              <AccordionContent>
                                <div className="space-y-2 pb-2">
                                  {atsResult.recommendations.map((rec, i) => (
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

            </Tabs>
          </div>
        </main>

        <Footer />

        {/* Hidden PDF Template for export */}
        {analysis && (() => {
          const SelectedTemplate = templates[selectedTemplate];
          return (
            <div style={{ position: 'absolute', left: '-9999px', top: 0 }}>
              <SelectedTemplate ref={pdfRef} resume={analysis.improvedResume} />
            </div>
          );
        })()}
      </div>
    </>
  );
}
