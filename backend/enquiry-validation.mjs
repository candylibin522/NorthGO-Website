export const enquiryFieldLimits = {
  name: 100, company: 150, email: 200, origin: 150, destination: 150,
  dimensions: 150, schedule: 150, requirements: 2000
};

export function normalizedEnquiry(input, { administrator = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const fields = {};
  for (const [key, max] of Object.entries(enquiryFieldLimits)) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > max) return null;
    fields[key] = value.trim();
  }
  if (!fields.name || !fields.company || !fields.requirements ||
      !/^\S+@[^\s@]+\.[^\s@]+$/.test(fields.email) ||
      !['string', 'number'].includes(typeof input.service) || !/^[0-3]$/.test(String(input.service)) ||
      !['string', 'number'].includes(typeof input.recipient) || !/^[0-6]$/.test(String(input.recipient)) ||
      !['zh', 'en', 'ja', 'vi'].includes(input.language) ||
      (!administrator && input.consent !== true) ||
      typeof input.reference !== 'string' || !/^[a-f0-9]{32}$/.test(input.reference)) return null;
  return {
    ...fields, service: Number(input.service), recipient: Number(input.recipient),
    language: input.language, reference: input.reference
  };
}
