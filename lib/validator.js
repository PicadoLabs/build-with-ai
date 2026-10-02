/**
 * Validates a template JSON object for required fields and proper Context DAG contracts.
 * @param {object} data - Parsed template JSON
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateTemplate(data) {
  const errors = [];

  // 1. Structure Validation
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Template must be a JSON object'] };
  }
  
  if (typeof data.title !== 'string' || data.title.trim() === '') {
    errors.push('Template missing required string field: "title"');
  }

  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    errors.push('Template missing required array field: "steps" (must contain at least one step)');
    return { valid: false, errors }; 
  }

  // 2. DAG Contract Validation (Placeholders and Requires)
  const availableKeys = new Set([
    'project.name',
    'project.templateId',
    'project.templateTitle',
    'project.experienceLevel',
    'project.idea',
    'project.totalSteps',
    'project'
  ]);

  const stepIds = new Set();
  const placeholderRegex = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

  data.steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') {
      errors.push(`Step at index ${index} is not an object.`);
      return;
    }

    if (typeof step.id !== 'string' || step.id.trim() === '') {
      errors.push(`Step at index ${index} missing required string field: "id"`);
    } else {
      if (stepIds.has(step.id)) {
        errors.push(`Duplicate step id found: "${step.id}"`);
      }
      stepIds.add(step.id);
    }

    if (typeof step.prompt !== 'string' || step.prompt.trim() === '') {
      errors.push(`Step "${step.id || index}" missing required string field: "prompt"`);
    } else {
      let match;
      while ((match = placeholderRegex.exec(step.prompt)) !== null) {
        const placeholder = match[1];
        let found = false;
        for (const key of availableKeys) {
            if (placeholder === key || placeholder.startsWith(key + '.')) {
                found = true;
                break;
            }
        }
        if (!found) {
          errors.push(`Step "${step.id || index}" uses placeholder "{{${placeholder}}}" which is never written by previous steps.`);
        }
      }
    }

    if (step.requires !== undefined) {
      if (!Array.isArray(step.requires)) {
        errors.push(`Step "${step.id || index}" field "requires" must be an array of strings.`);
      } else {
        step.requires.forEach(req => {
          if (typeof req !== 'string') {
             errors.push(`Step "${step.id || index}" requires array contains non-string: ${req}`);
          } else {
            let found = false;
            for (const key of availableKeys) {
                if (req === key || req.startsWith(key + '.')) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                errors.push(`Step "${step.id || index}" requires "${req}" which is never written by previous steps.`);
            }
          }
        });
      }
    }

    if (step.writes !== undefined) {
      if (!Array.isArray(step.writes)) {
        errors.push(`Step "${step.id || index}" field "writes" must be an array of strings.`);
      } else {
        step.writes.forEach(w => {
          if (typeof w !== 'string') {
             errors.push(`Step "${step.id || index}" writes array contains non-string: ${w}`);
          } else {
             availableKeys.add(w);
          }
        });
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = { validateTemplate };
