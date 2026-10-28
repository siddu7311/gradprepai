import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';

export async function extractTextFromPDF(file: File): Promise<string> {
  const { default: pdfWorkerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  try {
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map(item => 'str' in item ? item.str : '')
        .join(' ');
      fullText += pageText + '\n\n';
    }

    if (fullText.trim()) return fullText.trim();

    const { createWorker } = await import('tesseract.js');
    const ocrWorker = await createWorker('eng');

    try {
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');

        if (!context) throw new Error('Could not prepare this PDF page for text recognition.');

        try {
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          const { data } = await ocrWorker.recognize(canvas);
          fullText += data.text + '\n\n';
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      }

      return fullText.trim();
    } finally {
      await ocrWorker.terminate();
    }
  } finally {
    await pdf.destroy();
  }
}

export async function extractTextFromDOCX(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.trim();
}

export async function extractTextFromFile(file: File): Promise<string> {
  const fileName = file.name.toLowerCase();
  
  if (fileName.endsWith('.pdf')) {
    return extractTextFromPDF(file);
  } else if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
    return extractTextFromDOCX(file);
  } else if (
    fileName.endsWith('.txt') ||
    fileName.endsWith('.md') ||
    fileName.endsWith('.csv') ||
    fileName.endsWith('.json')
  ) {
    return file.text();
  }
  
  throw new Error('Unsupported file format. Please upload a PDF, DOCX, TXT, MD, CSV, or JSON file.');
}

export function isValidResumeFile(file: File): boolean {
  const validTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain'
  ];
  
  const fileName = file.name.toLowerCase();
  const validExtensions = ['.pdf', '.docx', '.doc', '.txt'];
  
  return validTypes.includes(file.type) || validExtensions.some(ext => fileName.endsWith(ext));
}

export function getFileIcon(fileName: string): string {
  const name = fileName.toLowerCase();
  if (name.endsWith('.pdf')) return '📄';
  if (name.endsWith('.docx') || name.endsWith('.doc')) return '📝';
  if (name.endsWith('.txt')) return '📃';
  return '📎';
}
