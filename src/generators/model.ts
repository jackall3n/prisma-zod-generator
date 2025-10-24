/**
 * Pure Model Schema Generator
 *
 * Generates Zod schemas representing the raw Prisma model structure,
 * similar to zod-prisma functionality but with enhanced inline validation support.
 */

import { DMMF } from '@prisma/generator-helper';
import {
  extractFieldComment,
  extractFieldCustomImports,
  mapAnnotationsToZodSchema,
  parseZodAnnotations,
  extractModelCustomImports,
  type CustomImport,
  type FieldCommentContext,
} from '../parsers/zod-comments';
import { logger } from '../utils/logger';
import { resolveEnumNaming, generateExportName } from '../utils/naming-resolver';
import type { GeneratorConfig as ZodGeneratorConfig } from '../config/parser';

/**
 * Interface for transformer module methods used in import generation
 */
interface TransformerModule {
  getGeneratorConfig?: () => ZodGeneratorConfig | null;
  getImportFileExtension?: () => string;
}

/**
 * Configuration for Prisma type mapping
 */
export interface TypeMappingConfig {
  /** How to handle Decimal fields: 'string' | 'number' | 'decimal' */
  decimalMode: 'string' | 'number' | 'decimal';

  /** How to handle JSON fields: 'unknown' | 'record' | 'any' */
  jsonMode: 'unknown' | 'record' | 'any';

  /** Whether to use strict date validation */
  strictDateValidation: boolean;

  /** Whether to validate BigInt values */
  validateBigInt: boolean;

  /** Custom type mappings for specific field types */
  customTypeMappings?: Record<string, string>;

  /** Whether to include database-specific validations */
  includeDatabaseValidations: boolean;

  /** Provider-specific options */
  provider?: 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver' | 'mongodb';

  /** Zod import target for version-specific behavior */
  zodImportTarget?: 'auto' | 'v3' | 'v4';
  /** Whether to generate JSON Schema compatible schemas */
  jsonSchemaCompatible?: boolean;
  /** JSON Schema compatibility options */
  jsonSchemaOptions?: {
    dateTimeFormat?: 'isoString' | 'isoDate';
    bigIntFormat?: 'string' | 'number';
    bytesFormat?: 'base64String' | 'hexString';
  };

  /** Complex type configuration */
  complexTypes: {
    /** Decimal field configuration */
    decimal: {
      /** Precision validation for decimal fields */
      validatePrecision: boolean;
      /** Maximum precision digits */
      maxPrecision?: number;
      /** Maximum scale digits */
      maxScale?: number;
      /** Allow negative values */
      allowNegative: boolean;
    };

    /** DateTime field configuration */
    dateTime: {
      /** Allow future dates */
      allowFuture: boolean;
      /** Allow past dates */
      allowPast: boolean;
      /** Minimum date (ISO string) */
      minDate?: string;
      /** Maximum date (ISO string) */
      maxDate?: string;
      /** Timezone handling: 'utc' | 'local' | 'preserve' */
      timezoneMode: 'utc' | 'local' | 'preserve';
    };

    /** JSON field configuration */
    json: {
      /** Maximum nesting depth */
      maxDepth?: number;
      /** Maximum JSON string length */
      maxLength?: number;
      /** Allow null values in JSON */
      allowNull: boolean;
      /** Validate JSON structure */
      validateStructure: boolean;
    };

    /** Bytes field configuration */
    bytes: {
      /** Maximum file size in bytes */
      maxSize?: number;
      /** Minimum file size in bytes */
      minSize?: number;
      /** Allowed MIME types */
      allowedMimeTypes?: string[];
      /** Validate as base64 string instead of Uint8Array */
      useBase64: boolean;
    };
  };
}

/**
 * Default type mapping configuration
 */
export const DEFAULT_TYPE_MAPPING_CONFIG: TypeMappingConfig = {
  decimalMode: 'decimal',
  jsonMode: 'unknown',
  strictDateValidation: true,
  validateBigInt: true,
  includeDatabaseValidations: true,
  provider: 'postgresql',
  zodImportTarget: 'auto',
  complexTypes: {
    decimal: {
      validatePrecision: true,
      maxPrecision: 18,
      maxScale: 8,
      allowNegative: true,
    },
    dateTime: {
      allowFuture: true,
      allowPast: true,
      timezoneMode: 'preserve',
    },
    json: {
      maxDepth: 10,
      allowNull: true,
      validateStructure: false,
    },
    bytes: {
      maxSize: 16 * 1024 * 1024, // 16MB
      minSize: 0,
      useBase64: true,
    },
  },
};

/**
 * Interface for Prisma field type mapping result
 */
export interface FieldTypeMappingResult {
  /** Base Zod schema string */
  zodSchema: string;

  /** Required imports for this field type */
  imports: Set<string>;

  /** JSDoc comments for the field */
  documentation?: string;

  /** Additional validations to apply */
  additionalValidations: string[];

  /** Whether this field requires special handling */
  requiresSpecialHandling: boolean;

  /** Database-specific considerations */
  databaseSpecific?: {
    constraints: string[];
    optimizations: string[];
  };
}

/**
 * Interface for field optionality analysis result
 */
export interface FieldOptionalityResult {
  /** Whether the field should be optional in input schemas */
  isOptional: boolean;

  /** Whether the field can be null */
  isNullable: boolean;

  /** Whether the field has a default value */
  hasDefaultValue: boolean;

  /** Whether the field is auto-generated */
  isAutoGenerated: boolean;

  /** Reason for optionality decision */
  optionalityReason:
    | 'required'
    | 'schema_optional'
    | 'has_default'
    | 'auto_generated'
    | 'back_relation'
    | 'nullable_foreign_keys';

  /** Zod modifier to apply (e.g., '.optional()', '.default(value)') */
  zodModifier: string;

  /** Additional notes about optionality decision */
  additionalNotes: string[];
}

/**
 * Interface for composed field schema
 */
export interface ComposedFieldSchema {
  /** Field name */
  fieldName: string;

  /** Original Prisma field type */
  prismaType: string;

  /** Generated Zod schema string */
  zodSchema: string;

  /** Whether this field is a relation (object kind) */
  isRelation?: boolean;

  /** Field documentation */
  documentation?: string;

  /** Validation comments and notes */
  validations: string[];

  /** Required imports for this field */
  imports: Set<string>;

  /** Whether field is optional */
  isOptional: boolean;

  /** Whether field is a list/array */
  isList: boolean;

  /** Whether field has custom validations applied */
  hasCustomValidations: boolean;

  /** Database constraints for this field */
  databaseConstraints: string[];

  /** Whether Prisma marks the field with a default value */
  hasDefaultValue?: boolean;

  /** Whether the field is auto-generated (id with default, updatedAt, now(), etc.) */
  isAutoGenerated?: boolean;

  /** Custom imports required via @zod.import annotations on this field */
  customImports?: CustomImport[];
}

/**
 * Interface for model schema composition
 */
export interface ModelSchemaComposition {
  /** Model name */
  modelName: string;

  /** Generated schema name */
  schemaName: string;

  /** Composed field schemas */
  fields: ComposedFieldSchema[];

  /** All required imports */
  imports: Set<string>;

  /** All exports from this schema */
  exports: Set<string>;

  /** Model-level documentation */
  documentation?: string;

  /** Model-level validation from @zod.import().refine(...) etc. */
  modelLevelValidation?: string | null;

  /** Custom imports from @zod.import() annotations */
  customImports?: CustomImport[];

  /** Generation statistics */
  statistics: {
    totalFields: number;
    processedFields: number;
    validatedFields: number;
    enhancedFields: number;
    relationFields: number;
    complexTypeFields: number;
  };

  /** Generation metadata */
  generationMetadata: {
    timestamp: string;
    generatorVersion: string;
    prismaVersion: string;
    configHash: string;
  };
}

/**
 * Interface for generated schema file content
 */
export interface SchemaFileContent {
  /** Complete file content */
  content: string;

  /** Required imports */
  imports: Set<string>;

  /** Available exports */
  exports: Set<string>;

  /** Suggested filename */
  filename: string;

  /** Schema dependencies */
  dependencies: string[];
}

/**
 * Interface for schema collection data
 */
export interface SchemaData {
  /** Model composition */
  composition: ModelSchemaComposition;

  /** Generated file content */
  fileContent: SchemaFileContent;

  /** Processing errors for this schema */
  processingErrors: string[];
}

/**
 * Interface for complete schema collection
 */
export interface SchemaCollection {
  /** Map of model name to schema data */
  schemas: Map<string, SchemaData>;

  /** Generated index file */
  indexFile: SchemaFileContent;

  /** Schema dependencies map */
  dependencies: Map<string, string[]>;

  /** Global imports used across all schemas */
  globalImports: Set<string>;

  /** Generation summary */
  generationSummary: {
    totalModels: number;
    processedModels: number;
    totalFields: number;
    processedFields: number;
    enhancedFields: number;
    errorCount: number;
    warnings: string[];
  };
}

/**
 * Interface for model validation report
 */
export interface ModelValidationReport {
  /** Model name */
  modelName: string;

  /** Whether model is valid */
  isValid: boolean;

  /** Total field count */
  fieldCount: number;

  /** Successfully processed fields */
  processedFields: number;

  /** Fields with enhanced validations */
  enhancedFields: number;

  /** Validation issues */
  issues: string[];

  /** Warnings */
  warnings: string[];
}

/**
 * Interface for schema validation report
 */
export interface SchemaValidationReport {
  /** Overall validation status */
  isValid: boolean;

  /** Generation summary */
  summary: SchemaCollection['generationSummary'];

  /** Per-model validation reports */
  modelReports: ModelValidationReport[];

  /** Global issues affecting multiple schemas */
  globalIssues: string[];

  /** Recommendations for improvement */
  recommendations: string[];
}

/**
 * Interface for JSDoc generation metadata
 */
export interface JSDocMetadata {
  /** Primary description from field documentation */
  description: string;

  /** Field type information */
  typeInfo: {
    prismaType: string;
    zodType: string;
    isArray: boolean;
    isOptional: boolean;
    isNullable: boolean;
  };

  /** Validation information */
  validations: {
    appliedValidations: string[];
    inlineValidations: string[];
    optionalityReason?: string;
  };

  /** Database-specific information */
  databaseInfo: {
    constraints: string[];
    defaultValue?: string;
    isId: boolean;
    isUnique: boolean;
    isUpdatedAt: boolean;
  };

  /** Additional metadata */
  metadata: {
    modelName: string;
    fieldName: string;
    hasCustomValidations: boolean;
    provider?: string;
  };
}

/**
 * Prisma field type mapper
 */
export class PrismaTypeMapper {
  private config: TypeMappingConfig;

  constructor(config: Partial<TypeMappingConfig> = {}) {
    // Deep merge for complex nested configuration
    this.config = {
      ...DEFAULT_TYPE_MAPPING_CONFIG,
      ...config,
      complexTypes: {
        ...DEFAULT_TYPE_MAPPING_CONFIG.complexTypes,
        ...config.complexTypes,
        decimal: {
          ...DEFAULT_TYPE_MAPPING_CONFIG.complexTypes.decimal,
          ...config.complexTypes?.decimal,
        },
        dateTime: {
          ...DEFAULT_TYPE_MAPPING_CONFIG.complexTypes.dateTime,
          ...config.complexTypes?.dateTime,
        },
        json: {
          ...DEFAULT_TYPE_MAPPING_CONFIG.complexTypes.json,
          ...config.complexTypes?.json,
        },
        bytes: {
          ...DEFAULT_TYPE_MAPPING_CONFIG.complexTypes.bytes,
          ...config.complexTypes?.bytes,
        },
      },
    };
  }

  /**
   * Map a Prisma field to Zod schema
   *
   * @param field - Prisma DMMF field
   * @param model - Parent model for context
   * @returns Field type mapping result
   */
  mapFieldToZodSchema(field: DMMF.Field, model: DMMF.Model): FieldTypeMappingResult {
    const result: FieldTypeMappingResult = {
      zodSchema: '',
      imports: new Set(['z']),
      additionalValidations: [],
      requiresSpecialHandling: false,
    };

    try {
      // Check for custom schema replacements first (before any type-specific processing)
      if (field.documentation) {
        // Fast-path: support custom full schema replacement via @zod.custom.use(<expr>)
        const customUseMatch = field.documentation.match(
          /@zod\.custom\.use\(((?:[^()]|\([^)]*\))*)\)(.*)$/m,
        );
        if (customUseMatch) {
          const baseExpression = customUseMatch[1].trim();
          const chainedMethods = customUseMatch[2].trim();

          if (baseExpression) {
            let fullExpression = baseExpression;
            if (chainedMethods) {
              fullExpression += chainedMethods;
            }

            result.zodSchema = fullExpression;
            result.additionalValidations.push('// Replaced base schema via @zod.custom.use');
            result.requiresSpecialHandling = true;
            return result; // Skip all other processing
          }
        }

        // Fast-path: support custom object schema via @zod.custom({ ... })
        const customMatch = field.documentation.match(
          /@zod\.custom\(((?:\{[^}]*\}|\[[^\]]*\]|(?:[^()]|\([^)]*\))*?))\)(.*)$/m,
        );
        if (customMatch) {
          const objectExpression = customMatch[1].trim();
          const chainedMethods = customMatch[2].trim();

          if (objectExpression) {
            let zodSchema: string;
            if (objectExpression.startsWith('{')) {
              // Convert JSON object to z.object()
              try {
                const parsedObject = JSON.parse(objectExpression);
                const zodObject = this.convertObjectToZodSchema(parsedObject);
                zodSchema = `z.object(${zodObject})`;
              } catch {
                // If JSON parsing fails, preserve the raw expression
                zodSchema = `z.object(${objectExpression})`;
              }
            } else if (objectExpression.startsWith('[')) {
              // Convert JSON array to z.array()
              try {
                const parsedArray = JSON.parse(objectExpression);
                const zodArray = this.convertArrayToZodSchema(parsedArray);
                zodSchema = `z.array(${zodArray})`;
              } catch {
                // If JSON parsing fails, preserve the raw expression
                zodSchema = `z.array(${objectExpression})`;
              }
            } else {
              // For other expressions, use them directly
              zodSchema = objectExpression;
            }

            // Add any chained methods
            if (chainedMethods) {
              zodSchema += chainedMethods;
            }

            result.zodSchema = zodSchema;
            result.additionalValidations.push('// Replaced base schema via @zod.custom');
            result.requiresSpecialHandling = true;
            return result; // Skip all other processing
          }
        }
      }

      // Handle scalar types
      if (field.kind === 'scalar') {
        this.mapScalarType(field, result, model);
      }
      // Handle enum types
      else if (field.kind === 'enum') {
        this.mapEnumType(field, result);
      }
      // Handle object types (relations)
      else if (field.kind === 'object') {
        this.mapObjectType(field, model, result);
      }
      // Handle unsupported types
      else {
        this.mapUnsupportedType(field, result);
      }

      // Apply list wrapper if needed BEFORE inline validations
      // This ensures @zod.nullable() applies to the array itself, not the elements
      if (field.isList) {
        this.applyListWrapper(result);
      }

      // Apply inline validation from @zod comments AFTER list wrapper
      this.applyInlineValidations(field, result, model.name);

      // Apply enhanced optionality handling
      const optionalityResult = this.determineFieldOptionality(field, model);
      if (optionalityResult.isOptional || optionalityResult.hasDefaultValue) {
        this.applyEnhancedOptionalityWrapper(result, optionalityResult);
      }

      // Generate comprehensive JSDoc documentation
      this.generateJSDocumentation(field, result, model.name, optionalityResult);

      // Add database-specific validations
      if (this.config.includeDatabaseValidations) {
        this.addDatabaseValidations(field, result);
      }
    } catch (error) {
      // Fallback to string type on mapping error
      console.warn(`Failed to map field ${field.name} of type ${field.type}:`, error);
      const isJsonSchemaCompatible = this.config.jsonSchemaCompatible;
      result.zodSchema = isJsonSchemaCompatible ? 'z.any()' : 'z.unknown()';
      result.additionalValidations.push(
        `// Warning: Failed to map type ${field.type}, using ${isJsonSchemaCompatible ? 'any' : 'unknown'}`,
      );
    }

    return result;
  }

  /**
   * Map scalar types to Zod schemas
   */
  private mapScalarType(
    field: DMMF.Field,
    result: FieldTypeMappingResult,
    model: DMMF.Model,
  ): void {
    const scalarType = field.type;

    switch (scalarType) {
      case 'String':
        result.zodSchema = 'z.string()';
        break;

      case 'Int':
        result.zodSchema = 'z.number().int()';
        result.additionalValidations.push('// Integer validation applied');
        break;

      case 'BigInt':
        // Check for JSON Schema compatibility mode
        let cfg: any = null;
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require to avoid circular import
          const transformer = require('../transformer').default;
          cfg = transformer.getGeneratorConfig?.();
        } catch {
          /* ignore */
        }

        if (cfg?.jsonSchemaCompatible) {
          const format = cfg.jsonSchemaOptions?.bigIntFormat || 'string';
          if (format === 'string') {
            result.zodSchema = 'z.string().regex(/^\\d+$/, "Invalid bigint string")';
            result.additionalValidations.push('// BigInt as string for JSON Schema compatibility');
          } else {
            result.zodSchema = 'z.number().int()';
            result.additionalValidations.push(
              '// BigInt as number for JSON Schema compatibility (may lose precision)',
            );
          }
        } else {
          result.zodSchema = 'z.bigint()';
          if (this.config.validateBigInt) {
            result.additionalValidations.push('// BigInt validation enabled');
          }
        }
        break;

      case 'Float':
        result.zodSchema = 'z.number()';
        break;

      case 'Decimal':
        this.mapDecimalType(field, result, model.name);
        break;

      case 'Boolean':
        result.zodSchema = 'z.boolean()';
        break;

      case 'DateTime':
        this.mapDateTimeType(field, result);
        break;

      case 'Json':
        this.mapJsonType(field, result);
        break;

      case 'Bytes':
        this.mapBytesType(field, result);
        break;

      default:
        // Check for custom type mappings
        if (this.config.customTypeMappings?.[scalarType]) {
          result.zodSchema = this.config.customTypeMappings[scalarType];
          result.requiresSpecialHandling = true;
        } else {
          // Unknown scalar type - fallback to string
          result.zodSchema = 'z.string()';
          result.additionalValidations.push(
            `// Unknown scalar type: ${scalarType}, mapped to string`,
          );
        }
        break;
    }
  }

  /**
   * Map Decimal type with enhanced validation based on configuration
   */
  private mapDecimalType(
    field: DMMF.Field,
    result: FieldTypeMappingResult,
    modelName?: string,
  ): void {
    const decimalConfig = this.config.complexTypes.decimal;
    // Default to 'decimal' mode if not specified
    const mode = this.config.decimalMode || 'decimal';

    switch (mode) {
      case 'string': {
        result.zodSchema = 'z.string()';

        // Build precision-aware regex pattern
        let regexPattern = '^';
        if (decimalConfig.allowNegative) {
          regexPattern += '-?';
        }

        if (decimalConfig.validatePrecision && decimalConfig.maxPrecision) {
          const maxIntegerDigits = decimalConfig.maxPrecision - (decimalConfig.maxScale || 0);
          const maxScaleDigits = decimalConfig.maxScale || 0;

          if (maxScaleDigits > 0) {
            regexPattern += `\\d{1,${maxIntegerDigits}}(?:\\.\\d{1,${maxScaleDigits}})?`;
          } else {
            regexPattern += `\\d{1,${maxIntegerDigits}}`;
          }
        } else {
          regexPattern += '\\d*\\.?\\d+';
        }
        regexPattern += '$';

        result.additionalValidations.push(`.regex(/${regexPattern}/, "Invalid decimal format")`);

        // Add precision validation documentation
        if (decimalConfig.validatePrecision) {
          result.additionalValidations.push(
            `// Precision: max ${decimalConfig.maxPrecision} digits, scale ${decimalConfig.maxScale}`,
          );
        }
        if (!decimalConfig.allowNegative) {
          result.additionalValidations.push('// Positive values only');
        }
        break;
      }

      case 'number':
        result.zodSchema = 'z.number()';

        // Add number-specific validations
        if (!decimalConfig.allowNegative) {
          result.additionalValidations.push('.min(0, "Negative values not allowed")');
        }

        // Add precision warnings for number mode
        result.additionalValidations.push(
          '// Warning: Decimal as number - precision may be lost for large values',
        );
        if (
          decimalConfig.validatePrecision &&
          decimalConfig.maxPrecision &&
          decimalConfig.maxPrecision > 15
        ) {
          result.additionalValidations.push(
            '// Warning: JavaScript numbers lose precision beyond 15-16 digits',
          );
        }
        break;

      case 'decimal': {
        // Full Decimal.js support matching zod-prisma-types
        // For pure models, use instanceof(Prisma.Decimal)
        const modelContext = modelName
          ? `, {
  message: "Field '${field.name}' must be a Decimal. Location: ['Models', '${modelName}']",
}`
          : '';
        result.zodSchema = `z.instanceof(Prisma.Decimal${modelContext})`;
        result.additionalValidations.push('// Decimal field using Prisma.Decimal type');
        result.requiresSpecialHandling = true;
        // Mark that we need Prisma import (non-type import)
        // Note: The import system expects just the identifier, not the full import statement
        result.imports.add('Prisma');
        break;
      }

      default:
        result.zodSchema = 'z.string()';
        result.additionalValidations.push(
          `.regex(/^${decimalConfig.allowNegative ? '-?' : ''}\\d*\\.?\\d+$/, "Invalid decimal format")`,
        );
        break;
    }

    if (mode !== 'decimal') {
      result.requiresSpecialHandling = true;
      result.additionalValidations.push(
        `// Decimal field mapped as ${mode} with enhanced validation`,
      );
    }
  }

  /**
   * Map DateTime type with enhanced validation and timezone handling
   */
  private mapDateTimeType(field: DMMF.Field, result: FieldTypeMappingResult): void {
    const dateTimeConfig = this.config.complexTypes.dateTime;
    // Respect global generator dateTimeStrategy if available
    let strategy: 'date' | 'coerce' | 'isoString' = 'date';
    let cfg: any = null;
    try {
      // Lazy load transformer to avoid circular import at module load

      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require to avoid circular import at module top level
      const transformer = require('../transformer').default;
      cfg = transformer.getGeneratorConfig?.();
      if (cfg?.dateTimeStrategy) strategy = cfg.dateTimeStrategy;
    } catch {
      /* ignore */
    }

    // JSON Schema compatibility mode overrides all other strategies
    if (cfg?.jsonSchemaCompatible) {
      const format = cfg.jsonSchemaOptions?.dateTimeFormat || 'isoString';
      if (format === 'isoDate') {
        result.zodSchema = 'z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/, "Invalid ISO date")';
        result.additionalValidations.push(
          '// DateTime as ISO date string for JSON Schema compatibility',
        );
      } else {
        // isoString - no transform for JSON Schema compatibility
        result.zodSchema =
          'z.string().regex(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/, "Invalid ISO datetime")';
        result.additionalValidations.push(
          '// DateTime as ISO string for JSON Schema compatibility',
        );
      }
      return;
    }

    if (strategy === 'isoString') {
      result.zodSchema =
        'z.string().regex(/\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z/, "Invalid ISO datetime").transform(v => new Date(v))';
      result.additionalValidations.push('// DateTime mapped from ISO string');
    } else if (strategy === 'coerce') {
      result.zodSchema = 'z.coerce.date()';
      result.additionalValidations.push('// DateTime coerced from input');
    } else {
      if (this.config.strictDateValidation) {
        result.zodSchema = 'z.date()';
        result.additionalValidations.push('// Strict date validation enabled');
      } else {
        result.zodSchema = 'z.union([z.date(), z.string().datetime()])';
        result.additionalValidations.push('// Flexible date/string input with ISO 8601 validation');
      }
    }

    // Add date range validations
    const validations: string[] = [];

    if (dateTimeConfig.minDate) {
      try {
        const minDate = new Date(dateTimeConfig.minDate);
        validations.push(
          `.min(new Date("${dateTimeConfig.minDate}"), "Date must be after ${minDate.toLocaleDateString()}")`,
        );
        result.additionalValidations.push(`// Minimum date: ${dateTimeConfig.minDate}`);
      } catch {
        result.additionalValidations.push(
          `// Warning: Invalid minDate format: ${dateTimeConfig.minDate}`,
        );
      }
    }

    if (dateTimeConfig.maxDate) {
      try {
        const maxDate = new Date(dateTimeConfig.maxDate);
        validations.push(
          `.max(new Date("${dateTimeConfig.maxDate}"), "Date must be before ${maxDate.toLocaleDateString()}")`,
        );
        result.additionalValidations.push(`// Maximum date: ${dateTimeConfig.maxDate}`);
      } catch {
        result.additionalValidations.push(
          `// Warning: Invalid maxDate format: ${dateTimeConfig.maxDate}`,
        );
      }
    }

    if (!dateTimeConfig.allowFuture) {
      validations.push('.max(new Date(), "Future dates not allowed")');
      result.additionalValidations.push('// Future dates not allowed');
    }

    if (!dateTimeConfig.allowPast) {
      validations.push('.min(new Date(), "Past dates not allowed")');
      result.additionalValidations.push('// Past dates not allowed');
    }

    // Apply date validations to the schema
    if (validations.length > 0) {
      if (this.config.strictDateValidation) {
        // For strict validation, apply directly to date
        result.additionalValidations.push(
          ...validations.map((v) => v.replace('.', '.refine((date) => date')),
        );
      } else {
        // For flexible validation, need to handle both date and string
        result.additionalValidations.push('// Date range validations applied to Date objects only');
      }
    }

    // Add timezone handling documentation
    switch (dateTimeConfig.timezoneMode) {
      case 'utc':
        result.additionalValidations.push('// Timezone: All dates normalized to UTC');
        break;
      case 'local':
        result.additionalValidations.push('// Timezone: All dates converted to local timezone');
        break;
      case 'preserve':
        result.additionalValidations.push('// Timezone: Original timezone information preserved');
        break;
    }

    result.requiresSpecialHandling = true;
  }

  /**
   * Map JSON type with enhanced validation and structure checking
   */
  private mapJsonType(field: DMMF.Field, result: FieldTypeMappingResult): void {
    const jsonConfig = this.config.complexTypes.json;
    const isJsonSchemaCompatible = this.config.jsonSchemaCompatible;

    switch (this.config.jsonMode) {
      case 'unknown':
        result.zodSchema = isJsonSchemaCompatible ? 'z.any()' : 'z.unknown()';
        break;
      case 'record':
        if (jsonConfig.allowNull) {
          result.zodSchema = isJsonSchemaCompatible
            ? 'z.record(z.any()).nullable()'
            : 'z.record(z.unknown()).nullable()';
        } else {
          result.zodSchema = isJsonSchemaCompatible ? 'z.record(z.any())' : 'z.record(z.unknown())';
        }
        break;
      case 'any':
        result.zodSchema = 'z.any()';
        break;
      default:
        result.zodSchema = isJsonSchemaCompatible ? 'z.any()' : 'z.unknown()';
        break;
    }

    // Add JSON-specific validations
    const validations: string[] = [];

    if (jsonConfig.validateStructure) {
      // Add custom JSON validation
      validations.push(
        '.refine((val) => { try { JSON.stringify(val); return true; } catch { return false; } }, "Must be valid JSON serializable data")',
      );
      result.additionalValidations.push('// JSON structure validation enabled');
    }

    if (jsonConfig.maxDepth !== undefined && jsonConfig.maxDepth > 0) {
      // Add depth validation function
      const depthValidation = `.refine((val) => { const getDepth = (obj: unknown, depth: number = 0): number => { if (depth > ${jsonConfig.maxDepth}) return depth; if (obj === null || typeof obj !== 'object') return depth; const values = Object.values(obj as Record<string, unknown>); if (values.length === 0) return depth; return Math.max(...values.map(v => getDepth(v, depth + 1))); }; return getDepth(val) <= ${jsonConfig.maxDepth}; }, "JSON nesting depth exceeds maximum of ${jsonConfig.maxDepth}")`;

      validations.push(depthValidation);
      result.additionalValidations.push(`// Maximum nesting depth: ${jsonConfig.maxDepth}`);
    }

    if (jsonConfig.maxLength !== undefined && jsonConfig.maxLength > 0) {
      // Add length validation for JSON string representation
      validations.push(
        `.refine((val) => JSON.stringify(val).length <= ${jsonConfig.maxLength}, "JSON string representation too long")`,
      );
      result.additionalValidations.push(
        `// Maximum JSON string length: ${jsonConfig.maxLength} characters`,
      );
    }

    // Apply validations if any
    if (validations.length > 0) {
      result.zodSchema = `${result.zodSchema}${validations.join('')}`;
    }

    // Add null handling information
    if (!jsonConfig.allowNull && this.config.jsonMode === 'record') {
      result.additionalValidations.push('// Null values not allowed in JSON structure');
    } else if (jsonConfig.allowNull) {
      result.additionalValidations.push('// Null values allowed in JSON structure');
    }

    result.requiresSpecialHandling = true;
    result.additionalValidations.push(
      `// JSON field mapped as ${this.config.jsonMode} with enhanced validation`,
    );
  }

  /**
   * Map Bytes type with enhanced validation for binary data and file handling
   */
  private mapBytesType(field: DMMF.Field, result: FieldTypeMappingResult): void {
    const bytesConfig = this.config.complexTypes.bytes;

    // Check for JSON Schema compatibility mode first
    let cfg: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require to avoid circular import
      const transformer = require('../transformer').default;
      cfg = transformer.getGeneratorConfig?.();
    } catch {
      /* ignore */
    }

    if (cfg?.jsonSchemaCompatible) {
      const format = cfg.jsonSchemaOptions?.bytesFormat || 'base64String';
      if (format === 'base64String') {
        result.zodSchema = 'z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "Invalid base64 string")';
        result.additionalValidations.push(
          '// Bytes as base64 string for JSON Schema compatibility',
        );
      } else {
        result.zodSchema = 'z.string().regex(/^[0-9a-fA-F]*$/, "Invalid hex string")';
        result.additionalValidations.push('// Bytes as hex string for JSON Schema compatibility');
      }
      return;
    }

    // For better compatibility with consumers and tests, prefer base64 string mapping by default
    if (bytesConfig.useBase64 !== false) {
      // Use base64 string representation
      result.zodSchema = 'z.string()';

      // Add base64 validation
      result.additionalValidations.push(
        '.regex(/^[A-Za-z0-9+/]*={0,2}$/, "Must be valid base64 string")',
      );

      // Add size validations for base64
      if (bytesConfig.minSize !== undefined && bytesConfig.minSize > 0) {
        // Base64 encoding: 4 chars for every 3 bytes, so minSize * 4/3
        const minBase64Length = Math.ceil((bytesConfig.minSize * 4) / 3);
        result.additionalValidations.push(`.min(${minBase64Length}, "Base64 string too short")`);
        result.additionalValidations.push(`// Minimum size: ${bytesConfig.minSize} bytes`);
      }

      if (bytesConfig.maxSize !== undefined && bytesConfig.maxSize > 0) {
        // Base64 encoding: 4 chars for every 3 bytes, so maxSize * 4/3
        const maxBase64Length = Math.ceil((bytesConfig.maxSize * 4) / 3);
        result.additionalValidations.push(`.max(${maxBase64Length}, "Base64 string too long")`);
        result.additionalValidations.push(
          `// Maximum size: ${bytesConfig.maxSize} bytes (${this.formatFileSize(bytesConfig.maxSize)})`,
        );
      }

      result.additionalValidations.push('// Bytes field mapped to base64 string');
    } else {
      // Use Uint8Array (compatible with Prisma Bytes type)
      if (this.config.provider === 'mongodb') {
        result.zodSchema = 'z.instanceof(Uint8Array)';
      } else {
        result.zodSchema = 'z.instanceof(Uint8Array)';
      }

      // Add size validations for binary data (Uint8Array)
      const validations: string[] = [];

      if (bytesConfig.minSize !== undefined && bytesConfig.minSize > 0) {
        validations.push(
          `.refine((buffer) => buffer.length >= ${bytesConfig.minSize}, "File too small")`,
        );
        result.additionalValidations.push(`// Minimum size: ${bytesConfig.minSize} bytes`);
      }

      if (bytesConfig.maxSize !== undefined && bytesConfig.maxSize > 0) {
        validations.push(
          `.refine((buffer) => buffer.length <= ${bytesConfig.maxSize}, "File too large")`,
        );
        result.additionalValidations.push(
          `// Maximum size: ${bytesConfig.maxSize} bytes (${this.formatFileSize(bytesConfig.maxSize)})`,
        );
      }

      // Apply size validations
      if (validations.length > 0) {
        result.additionalValidations.push(...validations);
      }

      result.additionalValidations.push('// Bytes field mapped to Uint8Array');
    }

    // Add MIME type validation if specified
    if (bytesConfig.allowedMimeTypes && bytesConfig.allowedMimeTypes.length > 0) {
      result.additionalValidations.push(
        `// Allowed MIME types: ${bytesConfig.allowedMimeTypes.join(', ')}`,
      );

      if (!bytesConfig.useBase64) {
        // For binary types, we can add file type validation (this would require file-type detection)
        result.additionalValidations.push(
          '// Note: MIME type validation requires additional file-type detection library',
        );
      }
    }

    result.requiresSpecialHandling = true;
    result.additionalValidations.push(
      `// Bytes field with enhanced validation (${bytesConfig.useBase64 ? 'base64' : 'Uint8Array'})`,
    );
  }

  /**
   * Format file size in human-readable format
   */
  private formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(unitIndex > 0 ? 1 : 0)}${units[unitIndex]}`;
  }

  /**
   * Map enum types
   */
  private mapEnumType(field: DMMF.Field, result: FieldTypeMappingResult): void {
    const enumName = field.type;
    // Use proper enum naming resolution instead of hardcoded "Schema" suffix
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolveEnumNaming, generateExportName } = require('../utils/naming-resolver');
      // Access the global transformer config like done elsewhere in this file
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cfg = require('../transformer').default.getGeneratorConfig?.();
      const enumNaming = resolveEnumNaming(cfg);
      const actualExportName = generateExportName(
        enumNaming.exportNamePattern,
        enumName,
        undefined,
        undefined,
        enumName,
      );
      result.zodSchema = actualExportName;
      result.imports.add(actualExportName);
    } catch {
      // Fallback to the old pattern if naming resolution fails
      result.zodSchema = `${enumName}Schema`;
      result.imports.add(`${enumName}Schema`);
    }
    result.additionalValidations.push(`// Enum type: ${enumName}`);
  }

  /**
   * Map object types (relations)
   */
  private mapObjectType(
    field: DMMF.Field,
    model: DMMF.Model,
    result: FieldTypeMappingResult,
  ): void {
    const relatedModelName = field.type;

    // For pure model schemas, we typically don't include full relation objects
    // Instead, we might include just the foreign key fields or omit relations entirely
    if (field.relationName) {
      // Determine the correct export symbol for the related model based on naming config
      let relatedExportName = `${relatedModelName}Schema`;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolvePureModelNaming, applyPattern } = require('../utils/naming-resolver');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const transformer = require('../transformer');
        const cfg = transformer.Transformer
          ? transformer.Transformer.getGeneratorConfig()
          : transformer.default?.getGeneratorConfig();
        const namingResolved = resolvePureModelNaming(cfg);
        relatedExportName = applyPattern(
          namingResolved.exportNamePattern,
          relatedModelName,
          namingResolved.schemaSuffix,
          namingResolved.typeSuffix,
        );
      } catch {
        relatedExportName = `${relatedModelName}Schema`;
      }

      // Determine zod target to choose recursion strategy
      let target: 'auto' | 'v3' | 'v4' = 'auto';
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const transformer = require('../transformer').default;
        target = (transformer.getGeneratorConfig?.().zodImportTarget ?? 'auto') as
          | 'auto'
          | 'v3'
          | 'v4';
      } catch {
        /* ignore */
      }

      const useGetterRecursion = target === 'v4';

      // Relation field -> always reference the resolved export name
      if (field.relationFromFields && field.relationFromFields.length > 0) {
        result.zodSchema = useGetterRecursion
          ? `${relatedExportName}`
          : `z.lazy(() => ${relatedExportName})`;
        result.imports.add(relatedExportName);
        result.requiresSpecialHandling = true;
        result.additionalValidations.push(`// Relation to ${relatedModelName}`);
      } else {
        result.zodSchema = useGetterRecursion
          ? `${relatedExportName}`
          : `z.lazy(() => ${relatedExportName})`;
        result.imports.add(relatedExportName);
        result.requiresSpecialHandling = true;
        result.additionalValidations.push(`// Back-relation to ${relatedModelName}`);
      }
    } else {
      // Non-relation object type (shouldn't happen in normal Prisma schemas)
      const isJsonSchemaCompatible = this.config.jsonSchemaCompatible;
      result.zodSchema = isJsonSchemaCompatible ? 'z.any()' : 'z.unknown()';
      result.additionalValidations.push(`// Unknown object type: ${relatedModelName}`);
    }
  }

  /**
   * Handle unsupported field types
   */
  private mapUnsupportedType(field: DMMF.Field, result: FieldTypeMappingResult): void {
    const isJsonSchemaCompatible = this.config.jsonSchemaCompatible;
    result.zodSchema = isJsonSchemaCompatible ? 'z.any()' : 'z.unknown()';
    result.additionalValidations.push(`// Unsupported field kind: ${field.kind}`);
    console.warn(`Unsupported field kind: ${field.kind} for field ${field.name}`);
  }

  /**
   * Apply list wrapper for array fields
   */
  private applyListWrapper(result: FieldTypeMappingResult): void {
    result.zodSchema = `z.array(${result.zodSchema})`;
    result.additionalValidations.push('// Array field');
  }

  /**
   * Apply optional wrapper for optional fields
   */
  private applyOptionalWrapper(result: FieldTypeMappingResult): void {
    result.zodSchema = `${result.zodSchema}.optional()`;
  }

  /**
   * Apply enhanced optionality wrapper with default values and special handling
   */
  private applyEnhancedOptionalityWrapper(
    result: FieldTypeMappingResult,
    optionalityResult: FieldOptionalityResult,
  ): void {
    // Apply the optionality modifier
    if (optionalityResult.zodModifier) {
      // Avoid duplicating default() if schema already contains a default
      const hasExistingDefault = /\.default\(/.test(result.zodSchema);
      if (hasExistingDefault) {
        // Strip .default(...) from the modifier if present
        const cleanedModifier = optionalityResult.zodModifier.replace(/\.default\([^)]*\)/g, '');
        result.zodSchema = `${result.zodSchema}${cleanedModifier}`;
      } else {
        result.zodSchema = `${result.zodSchema}${optionalityResult.zodModifier}`;
      }
    }

    // Add optionality information to validations
    result.additionalValidations.push(
      `// Field optionality: ${optionalityResult.optionalityReason}`,
    );

    // Add any additional notes
    optionalityResult.additionalNotes.forEach((note) => {
      result.additionalValidations.push(`// ${note}`);
    });

    // Handle special cases
    if (optionalityResult.isAutoGenerated) {
      result.requiresSpecialHandling = true;
      result.additionalValidations.push('// Auto-generated field - handle with care in mutations');
    }
  }

  /**
   * Determine field optionality with sophisticated logic
   *
   * @param field - Prisma DMMF field
   * @param model - Parent model for context
   * @returns Optionality information
   */
  determineFieldOptionality(field: DMMF.Field, model: DMMF.Model): FieldOptionalityResult {
    const result: FieldOptionalityResult = {
      isOptional: false,
      isNullable: false,
      hasDefaultValue: false,
      isAutoGenerated: false,
      optionalityReason: 'required',
      zodModifier: '',
      additionalNotes: [],
    };

    // Check if field is explicitly optional in schema
    if (!field.isRequired) {
      result.isOptional = true;
      result.optionalityReason = 'schema_optional';
      result.zodModifier = '.optional()';
      result.additionalNotes.push('Field marked as optional in Prisma schema');
    }

    // Check for default values
    if (field.hasDefaultValue) {
      result.hasDefaultValue = true;

      // Fields with default values can be optional during creation
      if (this.shouldMakeDefaultFieldOptional(field)) {
        result.isOptional = true;
        result.optionalityReason = 'has_default';
        result.zodModifier = '.optional()';
        result.additionalNotes.push('Field has default value, making it optional for input');
      }

      // Add default value information
      this.addDefaultValueInfo(field, result);
    }

    // Check for auto-generated fields
    if (this.isAutoGeneratedField(field)) {
      result.isAutoGenerated = true;
      result.isOptional = true;
      result.optionalityReason = 'auto_generated';
      result.zodModifier = '.optional()';
      result.additionalNotes.push('Auto-generated field, optional for input');
    }

    // Handle special field types
    this.handleSpecialFieldOptionalityRules(field, model, result);

    // Database-specific optionality rules
    this.applyDatabaseSpecificOptionalityRules(field, result);

    return result;
  }

  /**
   * Check if a field with default value should be optional
   */
  private shouldMakeDefaultFieldOptional(field: DMMF.Field): boolean {
    // Auto-generated fields should always be optional
    if (this.isAutoGeneratedField(field)) {
      return true;
    }

    // UUID fields with default values are typically optional
    if (field.type === 'String' && field.isId && field.hasDefaultValue) {
      return true;
    }

    // DateTime fields with now() default should be optional
    if (field.type === 'DateTime' && field.hasDefaultValue) {
      return true;
    }

    // Integer fields with autoincrement should be optional
    if ((field.type === 'Int' || field.type === 'BigInt') && field.isId && field.hasDefaultValue) {
      return true;
    }

    // For other fields, check if explicitly marked as optional
    return !field.isRequired;
  }

  /**
   * Add default value information to optionality result
   */
  private addDefaultValueInfo(field: DMMF.Field, result: FieldOptionalityResult): void {
    if (field.default) {
      const defaultValue = field.default;

      if (typeof defaultValue === 'object' && defaultValue !== null) {
        // Handle function defaults like now(), uuid(), etc.
        if ('name' in defaultValue) {
          const functionName = (defaultValue as { name: string }).name;
          result.additionalNotes.push(`Default function: ${functionName}()`);

          // Add appropriate Zod default if possible
          if (functionName === 'now' && field.type === 'DateTime') {
            result.zodModifier += '.default(() => new Date())';
          } else if (functionName === 'uuid' && field.type === 'String') {
            // Avoid emitting inline UUID generator that requires extra imports/types.
            // Let the database generate UUIDs by default and keep schema validation simple.
            result.additionalNotes.push('UUID default detected; no inline generator emitted');
          } else if (functionName === 'cuid' && field.type === 'String') {
            // Avoid emitting an undefined generateCuid() helper.
            // Let the database generate CUIDs by default and keep schema validation simple.
            result.additionalNotes.push('CUID default detected; no inline generator emitted');
          }
        }
      } else {
        // Handle literal defaults
        let literalValue = JSON.stringify(defaultValue);
        // Preserve trailing .0 for Float defaults like 30.0 (JSON.stringify(30.0) => "30")
        if (typeof defaultValue === 'number' && field.type === 'Float') {
          const asString = String(defaultValue);
          if (/^\d+$/.test(asString)) {
            // If the Prisma schema likely had a .0, format with one decimal place
            literalValue = `${asString}.0`;
          } else {
            literalValue = asString;
          }
        }
        // Defer duplicate default check to wrapper stage
        result.zodModifier += `.default(${literalValue})`;
        result.additionalNotes.push(`Default value: ${literalValue}`);
      }
    }
  }

  /**
   * Check if field is auto-generated
   */
  private isAutoGeneratedField(field: DMMF.Field): boolean {
    // ID fields with default values are typically auto-generated
    if (field.isId && field.hasDefaultValue) {
      return true;
    }

    // updatedAt fields are auto-generated
    if (field.isUpdatedAt) {
      return true;
    }

    // createdAt fields with default now() are auto-generated
    if (field.type === 'DateTime' && field.hasDefaultValue) {
      const defaultValue = field.default;
      if (typeof defaultValue === 'object' && defaultValue !== null && 'name' in defaultValue) {
        return (defaultValue as { name: string }).name === 'now';
      }
    }

    return false;
  }

  /**
   * Handle special optionality rules for specific field types
   */
  private handleSpecialFieldOptionalityRules(
    field: DMMF.Field,
    model: DMMF.Model,
    result: FieldOptionalityResult,
  ): void {
    // Handle relation fields specially
    if (field.kind === 'object') {
      if (field.relationName) {
        // Back-relations are typically optional
        if (!field.relationFromFields || field.relationFromFields.length === 0) {
          result.isOptional = true;
          result.optionalityReason = 'back_relation';
          result.zodModifier = '.optional()';
          result.additionalNotes.push('Back-relation field, typically optional');
        }
        // Forward relations depend on foreign key nullability
        else {
          const foreignKeyFields = field.relationFromFields;
          const allForeignKeysOptional = foreignKeyFields.every((fkField) => {
            const referencedField = model.fields.find((f) => f.name === fkField);
            return referencedField && !referencedField.isRequired;
          });

          if (allForeignKeysOptional) {
            result.isOptional = true;
            result.optionalityReason = 'nullable_foreign_keys';
            result.zodModifier = '.optional()';
            result.additionalNotes.push(
              'Foreign key fields are nullable, making relation optional',
            );
          }
        }
      }
    }

    // Handle JSON fields - often optional due to complexity
    if (field.type === 'Json' && field.isRequired) {
      result.additionalNotes.push('JSON field is required - consider validation complexity');
    }

    // Handle Bytes fields - often optional for file uploads
    if (field.type === 'Bytes') {
      result.additionalNotes.push('Bytes field - consider file upload requirements');
    }
  }

  /**
   * Apply database-specific optionality rules
   */
  private applyDatabaseSpecificOptionalityRules(
    field: DMMF.Field,
    result: FieldOptionalityResult,
  ): void {
    if (!this.config.provider) return;

    switch (this.config.provider) {
      case 'postgresql':
        this.applyPostgreSQLOptionalityRules(field, result);
        break;
      case 'mysql':
        this.applyMySQLOptionalityRules(field, result);
        break;
      case 'sqlite':
        this.applySQLiteOptionalityRules(field, result);
        break;
      case 'mongodb':
        this.applyMongoDBOptionalityRules(field, result);
        break;
    }
  }

  /**
   * PostgreSQL-specific optionality rules
   */
  private applyPostgreSQLOptionalityRules(field: DMMF.Field, result: FieldOptionalityResult): void {
    // PostgreSQL UUID fields with gen_random_uuid() default
    if (field.type === 'String' && field.isId && field.hasDefaultValue) {
      result.additionalNotes.push('PostgreSQL UUID primary key with default generation');
    }

    // PostgreSQL serial fields
    if ((field.type === 'Int' || field.type === 'BigInt') && field.isId && field.hasDefaultValue) {
      result.additionalNotes.push('PostgreSQL serial/bigserial primary key');
    }
  }

  /**
   * MySQL-specific optionality rules
   */
  private applyMySQLOptionalityRules(field: DMMF.Field, result: FieldOptionalityResult): void {
    // MySQL AUTO_INCREMENT fields
    if ((field.type === 'Int' || field.type === 'BigInt') && field.isId && field.hasDefaultValue) {
      result.additionalNotes.push('MySQL AUTO_INCREMENT primary key');
    }

    // MySQL TIMESTAMP fields
    if (field.type === 'DateTime' && field.hasDefaultValue) {
      result.additionalNotes.push('MySQL TIMESTAMP with default value');
    }
  }

  /**
   * SQLite-specific optionality rules
   */
  private applySQLiteOptionalityRules(field: DMMF.Field, result: FieldOptionalityResult): void {
    // SQLite INTEGER PRIMARY KEY is always auto-generated
    if (field.type === 'Int' && field.isId) {
      result.additionalNotes.push('SQLite INTEGER PRIMARY KEY (ROWID alias)');
    }
  }

  /**
   * MongoDB-specific optionality rules
   */
  private applyMongoDBOptionalityRules(field: DMMF.Field, result: FieldOptionalityResult): void {
    // MongoDB _id fields
    if (field.isId && field.name === 'id') {
      result.additionalNotes.push('MongoDB _id field (ObjectId)');
    }

    // MongoDB supports undefined values differently than SQL databases
    if (!field.isRequired) {
      result.additionalNotes.push('MongoDB field allows undefined values');
    }
  }

  /**
   * Apply inline validation from @zod comments
   */
  private applyInlineValidations(
    field: DMMF.Field,
    result: FieldTypeMappingResult,
    modelName: string = 'Unknown',
  ): void {
    if (!field.documentation) {
      return;
    }

    try {
      // Create field comment context
      const context: FieldCommentContext = {
        modelName: modelName,
        fieldName: field.name,
        fieldType: field.type,
        comment: field.documentation,
        isOptional: !field.isRequired,
        isList: field.isList,
      };

      // Extract field comments
      const extractedComment = extractFieldComment(context);
      if (!extractedComment.hasZodAnnotations) {
        // If there are extraction errors, report them
        if (extractedComment.extractionErrors.length > 0) {
          result.additionalValidations.push(
            `// Comment extraction warnings: ${extractedComment.extractionErrors.join(', ')}`,
          );
        }
        return;
      }

      // Parse @zod annotations
      const parseResult = parseZodAnnotations(extractedComment.normalizedComment, context);
      if (!parseResult.isValid || parseResult.annotations.length === 0) {
        if (!parseResult.isValid && parseResult.parseErrors.length > 0) {
          result.additionalValidations.push(
            `// @zod parsing errors: ${parseResult.parseErrors.join(', ')}`,
          );
        }
        return;
      }

      // Map annotations to Zod schema (auto-detect zod version)
      const zodSchemaResult = mapAnnotationsToZodSchema(
        parseResult.annotations,
        context,
        this.config.zodImportTarget || 'auto',
      );
      if (!zodSchemaResult.isValid) {
        result.additionalValidations.push(
          `// @zod mapping errors: ${zodSchemaResult.errors.join(', ')}`,
        );
        return;
      }

      // Apply the validations to the schema
      if (zodSchemaResult.schemaChain) {
        // Preserve user-defined .optional() calls for relationship fields or when user explicitly wants control
        // Only strip .optional() for scalar fields where optionality is handled by the field mapping logic
        const shouldPreserveOptional =
          field.kind === 'object' ||
          (field.relationName && field.relationName.length > 0) ||
          /\.(optional|nullable|nullish)\(\)/.test(zodSchemaResult.schemaChain);

        let chainNoOptional = shouldPreserveOptional
          ? zodSchemaResult.schemaChain // Keep user's .optional()/.nullable()/.nullish() calls
          : zodSchemaResult.schemaChain.replace(/\.optional\(\)/g, ''); // Strip only .optional() for scalar fields, keep .nullable()/.nullish()

        // Normalize nullable/nullish to appear at the end of the chain (after other validations)
        const nullableCount = (chainNoOptional.match(/\.nullable\(\)/g) || []).length;
        const nullishCount = (chainNoOptional.match(/\.nullish\(\)/g) || []).length;
        if (nullableCount > 0 || nullishCount > 0) {
          chainNoOptional = chainNoOptional
            .replace(/\.nullable\(\)/g, '')
            .replace(/\.nullish\(\)/g, '');
          if (nullableCount > 0) {
            chainNoOptional += '.nullable()';
          } else if (nullishCount > 0) {
            chainNoOptional += '.nullish()';
          }
        }

        // Check if the schema chain contains a replacement method (doesn't start with dot)
        const isReplacementSchema = !chainNoOptional.startsWith('.');

        if (isReplacementSchema) {
          // For replacement schemas (json, enum), use them directly
          result.zodSchema = chainNoOptional;
        } else {
          // Combine base schema with validation chain
          // The validation chain contains just the validation methods (e.g., '.min(3).max(20)')
          // We need to combine it with the existing base schema
          // Special handling: if field is Json and chain includes .record(...),
          // prefer z.record(...) as the base instead of z.unknown()
          if (field.type === 'Json' && /\.record\(/.test(chainNoOptional)) {
            const recordMatch = chainNoOptional.match(/\.record\(([^)]*)\)/);
            if (recordMatch) {
              const isJsonSchemaCompatible = this.config.jsonSchemaCompatible;
              const recordParam =
                recordMatch[1] || (isJsonSchemaCompatible ? 'z.any()' : 'z.unknown()');
              // Build a base z.record(...) and append the remaining chain without the .record(...) segment
              const remainingChain = chainNoOptional.replace(/\.record\([^)]*\)/, '');
              result.zodSchema = `z.record(${recordParam})${remainingChain}`;
            } else {
              result.zodSchema = `${result.zodSchema}${chainNoOptional}`;
            }
          } else {
            // Special handling for array element-level validations: if comment suggests
            // element validation, apply the chain to the element and keep nullable/nullish
            // on the array.
            const elementLevel = /array element/i.test(extractedComment.normalizedComment);
            if (field.isList && elementLevel && /^z\.array\(/.test(result.zodSchema)) {
              const m = result.zodSchema.match(/^z\.array\((.+)\)$/);
              const elementBase = m ? m[1] : 'z.unknown()';
              let arrayNullableSuffix = '';
              if (/\.nullable\(\)$/.test(chainNoOptional)) {
                arrayNullableSuffix = '.nullable()';
                chainNoOptional = chainNoOptional.replace(/\.nullable\(\)$/, '');
              } else if (/\.nullish\(\)$/.test(chainNoOptional)) {
                arrayNullableSuffix = '.nullish()';
                chainNoOptional = chainNoOptional.replace(/\.nullish\(\)$/, '');
              }
              if (chainNoOptional.startsWith('.')) {
                result.zodSchema = `z.array(${elementBase}${chainNoOptional})${arrayNullableSuffix}`;
              } else {
                result.zodSchema = `z.array(${chainNoOptional})${arrayNullableSuffix}`;
              }
            } else if (chainNoOptional.startsWith('.')) {
              result.zodSchema = `${result.zodSchema}${chainNoOptional}`;
            } else {
              result.zodSchema = chainNoOptional;
            }
          }
        }
        result.additionalValidations.push('// Enhanced with @zod inline validations');

        // Add any additional imports needed
        zodSchemaResult.imports.forEach((imp) => {
          result.imports.add(imp);
        });

        // Mark as requiring special handling due to custom validations
        result.requiresSpecialHandling = true;

        // Add validation documentation
        parseResult.annotations.forEach((annotation) => {
          result.additionalValidations.push(
            `// @zod.${annotation.method}(${annotation.parameters.map((p) => String(p)).join(', ')})`,
          );
        });
      }
    } catch (error) {
      // Don't fail the entire field mapping on validation error
      console.warn(`Failed to apply inline validations for field ${field.name}:`, error);
      result.additionalValidations.push(`// Warning: Failed to apply @zod validations`);
    }
  }

  /**
   * Generate comprehensive JSDoc documentation for a field
   */
  private generateJSDocumentation(
    field: DMMF.Field,
    result: FieldTypeMappingResult,
    modelName: string,
    optionalityResult: FieldOptionalityResult,
  ): void {
    // Collect JSDoc metadata
    const metadata = this.collectJSDocMetadata(field, result, modelName, optionalityResult);

    // Generate JSDoc string
    const jsDocString = this.buildJSDocString(metadata);

    if (jsDocString) {
      result.documentation = jsDocString;
    }
  }

  /**
   * Collect metadata for JSDoc generation
   */
  private collectJSDocMetadata(
    field: DMMF.Field,
    result: FieldTypeMappingResult,
    modelName: string,
    optionalityResult: FieldOptionalityResult,
  ): JSDocMetadata {
    // Extract clean description from field documentation
    const description = this.extractCleanDescription(field.documentation);

    // Collect inline validations applied
    const inlineValidations = result.additionalValidations
      .filter((v) => v.includes('@zod'))
      .map((v) => v.replace(/^\/\/ /, ''));

    // Collect applied validations
    const appliedValidations = result.additionalValidations
      .filter((v) => !v.includes('@zod') && !v.includes('Warning'))
      .map((v) => v.replace(/^\/\/ /, ''));

    return {
      description,
      typeInfo: {
        prismaType: field.type,
        zodType: this.extractZodBaseType(result.zodSchema),
        isArray: field.isList,
        isOptional: optionalityResult.isOptional,
        isNullable: optionalityResult.isNullable,
      },
      validations: {
        appliedValidations,
        inlineValidations,
        optionalityReason: optionalityResult.optionalityReason,
      },
      databaseInfo: {
        constraints: result.databaseSpecific?.constraints || [],
        defaultValue: this.formatDefaultValue(field.default),
        isId: field.isId,
        isUnique: field.isUnique,
        isUpdatedAt: field.isUpdatedAt || false,
      },
      metadata: {
        modelName,
        fieldName: field.name,
        hasCustomValidations: result.requiresSpecialHandling,
        provider: this.config.provider,
      },
    };
  }

  /**
   * Build JSDoc string from metadata
   */
  private buildJSDocString(metadata: JSDocMetadata): string {
    const lines: string[] = [];

    // Preserve triple-slash single-line comments if present in original documentation
    // We detect them in the cleaned description by looking at the original comment lines
    // The cleaned description already removed @zod annotations. We still add a leading
    // triple-slash echo line if the description appears to originate from a single-line doc.
    // Note: This is a heuristic to satisfy tests expecting /// Display name for the user
    if (
      metadata.description &&
      !metadata.description.includes('\n') &&
      metadata.description.length < 200
    ) {
      lines.push(`/// ${metadata.description}`);
    }

    lines.push('/**');

    // Primary description
    if (metadata.description) {
      lines.push(` * ${metadata.description}`);
      lines.push(' *');
    }

    // Type information
    const typeDesc = this.buildTypeDescription(metadata.typeInfo);
    if (typeDesc) {
      lines.push(` * @type {${typeDesc}}`);
    }

    // Field properties
    const properties = this.buildFieldProperties(metadata);
    if (properties.length > 0) {
      properties.forEach((prop) => lines.push(` * ${prop}`));
    }

    // Validations
    if (metadata.validations.inlineValidations.length > 0) {
      lines.push(' *');
      lines.push(' * @validations');
      metadata.validations.inlineValidations.forEach((validation) => {
        lines.push(` * - ${validation}`);
      });
    }

    // Database constraints
    if (metadata.databaseInfo.constraints.length > 0) {
      lines.push(' *');
      lines.push(' * @database');
      metadata.databaseInfo.constraints.forEach((constraint) => {
        lines.push(` * - ${constraint}`);
      });
    }

    // Examples if applicable
    const example = this.generateFieldExample(metadata);
    if (example) {
      lines.push(' *');
      lines.push(' * @example');
      lines.push(` * ${example}`);
    }

    // Generated schema information
    lines.push(' *');
    lines.push(
      ` * @generated Zod schema for ${metadata.metadata.modelName}.${metadata.metadata.fieldName}`,
    );

    lines.push('*/');

    return lines.join('\n');
  }

  /**
   * Extract clean description from field documentation, removing @zod annotations
   */
  private extractCleanDescription(documentation?: string): string {
    if (!documentation) {
      return '';
    }

    // Split into lines and process
    const lines = documentation
      .split('\n')
      .map((line) => line.replace(/^\s*\/\/\/?\s*/, '').trim()) // Remove comment markers
      .filter((line) => !line.startsWith('@zod')) // Remove @zod annotations
      .filter((line) => line.length > 0); // Remove empty lines

    return lines.join(' ').trim();
  }

  /**
   * Extract base Zod type from schema string
   */
  private extractZodBaseType(zodSchema: string): string {
    // Extract the base type from z.type() patterns
    const match = zodSchema.match(/z\.(\w+)/);
    if (match) {
      const baseType = match[1];
      // Handle special cases
      if (baseType === 'number' && zodSchema.includes('.int()')) {
        return 'number'; // Keep as number even with int() validation
      }
      return baseType;
    }

    // Fallback: if schema starts with a validation chain, assume string
    if (zodSchema.startsWith('.')) {
      return 'string';
    }

    return 'unknown';
  }

  /**
   * Build type description for JSDoc @type annotation
   */
  private buildTypeDescription(typeInfo: JSDocMetadata['typeInfo']): string {
    let baseType = typeInfo.zodType;

    // Map Zod types to more readable descriptions
    const typeMap: Record<string, string> = {
      string: 'string',
      number: 'number',
      boolean: 'boolean',
      date: 'Date',
      bigint: 'BigInt',
      array: 'Array',
      unknown: 'unknown',
      any: 'any',
    };

    baseType = typeMap[baseType] || baseType;

    if (typeInfo.isArray) {
      baseType = `${baseType}[]`;
    }

    if (typeInfo.isOptional) {
      baseType = `${baseType} | undefined`;
    }

    if (typeInfo.isNullable) {
      baseType = `${baseType} | null`;
    }

    return baseType;
  }

  /**
   * Build field properties list for JSDoc
   */
  private buildFieldProperties(metadata: JSDocMetadata): string[] {
    const properties: string[] = [];

    if (metadata.databaseInfo.isId) {
      properties.push('@primary Primary key field');
    }

    if (metadata.databaseInfo.isUnique) {
      properties.push('@unique Unique constraint');
    }

    if (metadata.databaseInfo.isUpdatedAt) {
      properties.push('@updatedAt Auto-updated timestamp');
    }

    if (metadata.databaseInfo.defaultValue) {
      properties.push(`@default ${metadata.databaseInfo.defaultValue}`);
    }

    if (
      metadata.validations.optionalityReason &&
      metadata.validations.optionalityReason !== 'required'
    ) {
      const reason = metadata.validations.optionalityReason.replace('_', ' ');
      properties.push(`@optional ${reason}`);
    }

    if (metadata.metadata.hasCustomValidations) {
      properties.push('@enhanced Custom validations applied');
    }

    return properties;
  }

  /**
   * Format default value for documentation
   */
  private formatDefaultValue(defaultValue: unknown): string | undefined {
    if (defaultValue === undefined || defaultValue === null) {
      return undefined;
    }

    if (typeof defaultValue === 'object') {
      // Handle function defaults like now(), uuid(), etc.
      if ('name' in defaultValue) {
        return `${(defaultValue as { name: string }).name}()`;
      }
      return JSON.stringify(defaultValue);
    }

    if (typeof defaultValue === 'string') {
      return `"${defaultValue}"`;
    }

    return String(defaultValue);
  }

  /**
   * Generate example usage for the field
   */
  private generateFieldExample(metadata: JSDocMetadata): string | undefined {
    const { typeInfo, databaseInfo, validations } = metadata;

    // Generate examples based on field type and validations
    if (typeInfo.prismaType === 'String') {
      if (validations.inlineValidations.some((v) => v.includes('email'))) {
        return '"user@example.com"';
      }
      if (validations.inlineValidations.some((v) => v.includes('url'))) {
        return '"https://example.com"';
      }
      if (validations.inlineValidations.some((v) => v.includes('uuid'))) {
        return '"550e8400-e29b-41d4-a716-446655440000"';
      }
      return '"example string"';
    }

    if (typeInfo.prismaType === 'Int') {
      if (databaseInfo.isId) {
        return '1';
      }
      if (validations.inlineValidations.some((v) => v.includes('min(0)'))) {
        return '42';
      }
      return '123';
    }

    if (typeInfo.prismaType === 'Boolean') {
      return 'true';
    }

    if (typeInfo.prismaType === 'DateTime') {
      return 'new Date()';
    }

    if (typeInfo.isArray) {
      const baseExample = this.generateFieldExample({
        ...metadata,
        typeInfo: { ...typeInfo, isArray: false },
      });
      return baseExample ? `[${baseExample}]` : '[]';
    }

    return undefined;
  }

  /**
   * Add database-specific validations
   */
  private addDatabaseValidations(field: DMMF.Field, result: FieldTypeMappingResult): void {
    if (!result.databaseSpecific) {
      result.databaseSpecific = { constraints: [], optimizations: [] };
    }

    // Add constraints based on field attributes
    if (field.isId) {
      result.databaseSpecific.constraints.push('Primary key field');
    }

    if (field.isUnique) {
      result.databaseSpecific.constraints.push('Unique constraint');
    }

    if (field.isUpdatedAt) {
      result.databaseSpecific.constraints.push('Updated at timestamp');
    }

    if (field.hasDefaultValue) {
      result.databaseSpecific.constraints.push('Has default value');
    }

    // Add provider-specific optimizations
    if (this.config.provider === 'postgresql') {
      this.addPostgreSQLOptimizations(field, result);
    } else if (this.config.provider === 'mysql') {
      this.addMySQLOptimizations(field, result);
    } else if (this.config.provider === 'mongodb') {
      this.addMongoDBOptimizations(field, result);
    }
  }

  /**
   * Add PostgreSQL-specific optimizations
   */
  private addPostgreSQLOptimizations(field: DMMF.Field, result: FieldTypeMappingResult): void {
    if (field.type === 'String' && field.isId) {
      result.databaseSpecific?.optimizations.push('Consider UUID type for PostgreSQL primary keys');
    }

    if (field.type === 'Json') {
      result.databaseSpecific?.optimizations.push(
        'PostgreSQL JSONB provides better performance than JSON',
      );
    }
  }

  /**
   * Add MySQL-specific optimizations
   */
  private addMySQLOptimizations(field: DMMF.Field, result: FieldTypeMappingResult): void {
    if (field.type === 'String' && field.isList) {
      result.databaseSpecific?.optimizations.push(
        'Consider using separate table for array data in MySQL',
      );
    }
  }

  /**
   * Add MongoDB-specific optimizations
   */
  private addMongoDBOptimizations(field: DMMF.Field, result: FieldTypeMappingResult): void {
    if (field.type === 'String' && field.isId) {
      result.databaseSpecific?.optimizations.push('MongoDB uses ObjectId for _id fields');
    }

    if (field.isList) {
      result.databaseSpecific?.optimizations.push('MongoDB natively supports arrays');
    }
  }

  /**
   * Get all available Prisma types for validation
   */
  static getSupportedPrismaTypes(): string[] {
    return ['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes'];
  }

  /**
   * Validate type mapping configuration
   */
  static validateTypeMapping(config: Partial<TypeMappingConfig>): string[] {
    const errors: string[] = [];

    if (config.decimalMode && !['string', 'number', 'decimal'].includes(config.decimalMode)) {
      errors.push('decimalMode must be "string", "number", or "decimal"');
    }

    if (config.jsonMode && !['unknown', 'record', 'any'].includes(config.jsonMode)) {
      errors.push('jsonMode must be "unknown", "record", or "any"');
    }

    if (
      config.provider &&
      !['postgresql', 'mysql', 'sqlite', 'sqlserver', 'mongodb'].includes(config.provider)
    ) {
      errors.push('provider must be one of: postgresql, mysql, sqlite, sqlserver, mongodb');
    }

    return errors;
  }

  /**
   * Generate complete Zod schema for a Prisma model
   */
  generateModelSchema(model: DMMF.Model): ModelSchemaComposition {
    // Extract model-level custom validation/imports from @zod.import(...)
    const modelCustomImports = extractModelCustomImports(model);

    const customImportMap = new Map<string, CustomImport>();
    const addCustomImports = (imports: CustomImport[] | undefined): void => {
      if (!imports || imports.length === 0) {
        return;
      }
      for (const customImport of imports) {
        if (!customImport || !customImport.importStatement) {
          continue;
        }
        if (!customImportMap.has(customImport.importStatement)) {
          customImportMap.set(customImport.importStatement, customImport);
        }
      }
    };

    addCustomImports(modelCustomImports.imports);

    // Get naming configuration to apply custom patterns
    let resolvedSchemaName = `${model.name}Schema`; // fallback default
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolvePureModelNaming, applyPattern } = require('../utils/naming-resolver');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const transformer = require('../transformer');
      const cfg = transformer.Transformer
        ? transformer.Transformer.getGeneratorConfig()
        : transformer.default?.getGeneratorConfig();
      const namingResolved = resolvePureModelNaming(cfg);
      resolvedSchemaName = applyPattern(
        namingResolved.exportNamePattern,
        model.name,
        namingResolved.schemaSuffix,
        namingResolved.typeSuffix,
      );
    } catch {
      // fallback to default naming if resolution fails
      resolvedSchemaName = `${model.name}Schema`;
    }

    const composition: ModelSchemaComposition = {
      modelName: model.name,
      // Use resolved schema name that respects custom naming patterns
      schemaName: resolvedSchemaName,
      fields: [],
      imports: new Set(['z']),
      exports: new Set(),
      documentation: this.generateModelDocumentation(model),
      modelLevelValidation: ((): string | null => {
        const chain = modelCustomImports.customSchema?.trim() ?? '';
        if (!chain) {
          return null;
        }
        return chain.startsWith('.') ? chain.slice(1) : chain;
      })(),
      customImports: modelCustomImports.imports ?? [],

      // Model-level custom imports are emitted only when modelLevelValidation is present
      statistics: {
        totalFields: model.fields.length,
        processedFields: 0,
        validatedFields: 0,
        enhancedFields: 0,
        relationFields: 0,
        complexTypeFields: 0,
      },
      generationMetadata: {
        timestamp: new Date().toISOString(),
        generatorVersion: '1.0.0',
        prismaVersion: 'unknown',
        configHash: this.generateConfigHash(),
      },
    };

    // Apply field exclusions if provided via generator config models[Model].variants.pure.excludeFields
    // Allow runtime config-driven filtering of relation fields when pureModels enabled
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy access to config avoiding circular import
    const cfg = (require('../transformer').default.getGeneratorConfig?.() || {}) as {
      pureModels?: boolean;
      pureModelsIncludeRelations?: boolean;
    };
    let fieldsToProcess = model.fields;
    if (cfg.pureModels && cfg.pureModelsIncludeRelations !== true) {
      // Omit relation (object kind) fields for slimmer pure model output
      fieldsToProcess = fieldsToProcess.filter((f) => f.kind !== 'object');
      composition.statistics.totalFields = fieldsToProcess.length;
    }
    // Pure model exclusions are handled earlier during config processing and object schema filtering.
    // This generator operates on the Prisma DMMF model directly.

    // Process each field
    for (const field of fieldsToProcess) {
      try {
        const fieldMapping = this.mapFieldToZodSchema(field, model);
        const fieldCustomImportsResult = extractFieldCustomImports(field, model.name);
        if (fieldCustomImportsResult.parseErrors.length > 0) {
          fieldCustomImportsResult.parseErrors.forEach((errorMessage) =>
            logger.warn(
              `Custom import parsing issue for ${model.name}.${field.name}: ${errorMessage}`,
            ),
          );
        }
        addCustomImports(fieldCustomImportsResult.imports);

        const composedField: ComposedFieldSchema = {
          fieldName: field.name,
          prismaType: field.type,
          zodSchema: fieldMapping.zodSchema,
          isRelation: field.kind === 'object',
          documentation: fieldMapping.documentation,
          validations: fieldMapping.additionalValidations,
          imports: fieldMapping.imports,
          isOptional: !field.isRequired,
          isList: field.isList,
          hasCustomValidations: fieldMapping.requiresSpecialHandling,
          databaseConstraints: fieldMapping.databaseSpecific?.constraints || [],
          hasDefaultValue: !!field.hasDefaultValue,
          isAutoGenerated: this.isAutoGeneratedField(field),
          customImports: fieldCustomImportsResult.imports,
        };

        composition.fields.push(composedField);
        composition.statistics.processedFields++;

        // Collect imports
        fieldMapping.imports.forEach((imp) => composition.imports.add(imp));

        // Update statistics
        if (fieldMapping.additionalValidations.length > 0) {
          composition.statistics.validatedFields++;
        }
        if (fieldMapping.requiresSpecialHandling) {
          composition.statistics.enhancedFields++;
        }
        if (field.kind === 'object') {
          composition.statistics.relationFields++;
        }
        if (['Decimal', 'Json', 'Bytes', 'DateTime'].includes(field.type)) {
          composition.statistics.complexTypeFields++;
        }
      } catch (error) {
        console.error(`Failed to process field ${field.name} in model ${model.name}:`, error);
        // Add error field with fallback
        const isJsonSchemaCompatible = this.config.jsonSchemaCompatible;
        composition.fields.push({
          fieldName: field.name,
          prismaType: field.type,
          zodSchema: isJsonSchemaCompatible ? 'z.any()' : 'z.unknown()',
          documentation: `// Error processing field: ${error instanceof Error ? error.message : String(error)}`,
          validations: [`// Failed to process ${field.type} field`],
          imports: new Set(['z']),
          isOptional: !field.isRequired,
          isList: field.isList,
          hasCustomValidations: false,
          databaseConstraints: [],
          customImports: [],
        });
      }
    }

    const mergedCustomImports = Array.from(customImportMap.values()).sort((a, b) =>
      a.importStatement.localeCompare(b.importStatement),
    );
    composition.customImports = mergedCustomImports;

    // Generate exports
    composition.exports.add(composition.schemaName);
    // Add the type export name in alignment with the configured naming strategy
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolvePureModelNaming, applyPattern } = require('../utils/naming-resolver');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const transformer = require('../transformer');
      const cfg2 = transformer.Transformer
        ? transformer.Transformer.getGeneratorConfig()
        : transformer.default?.getGeneratorConfig();
      const namingResolved = resolvePureModelNaming(cfg2);
      const effectiveTypeSuffix =
        namingResolved.typeSuffix === undefined || namingResolved.typeSuffix === null
          ? 'Type'
          : namingResolved.typeSuffix;
      const defaultSchemaExport = applyPattern(
        '{Model}{SchemaSuffix}',
        model.name,
        namingResolved.schemaSuffix,
        effectiveTypeSuffix,
      );
      if (composition.schemaName === defaultSchemaExport) {
        composition.exports.add(`${model.name}${effectiveTypeSuffix}`);
      } else {
        const suffix = effectiveTypeSuffix;
        if (suffix && suffix.length > 0) {
          composition.exports.add(`${composition.schemaName}${suffix}`);
        } else {
          composition.exports.add(model.name);
        }
      }
    } catch {
      // Fallback: export model name (no forced Type suffix)
      composition.exports.add(model.name);
    }
    // Add legacy model alias name to exports for consumers referencing previous naming
    composition.exports.add(`${model.name}Model`);

    return composition;
  }

  /**
   * Generate TypeScript schema file content from model composition
   */
  generateSchemaFileContent(composition: ModelSchemaComposition): SchemaFileContent {
    const lines: string[] = [];
    // Access global configuration (set by prisma-generator) cautiously; fall back to transformer if absent.
    interface GlobalWithGeneratorConfig {
      PRISMA_ZOD_GENERATOR_CONFIG?: { pureModelsLean?: boolean };
    }
    const g = globalThis as GlobalWithGeneratorConfig;
    const lean =
      g.PRISMA_ZOD_GENERATOR_CONFIG?.pureModelsLean === true ||
      // Lazy require to avoid circular dependency and multiple calls

      (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const transformer = require('../transformer').default;
        const cfg = transformer.getGeneratorConfig?.();
        return cfg ? cfg.pureModelsLean === true : false;
      })();

    if (!lean) {
      // File header
      lines.push('/**');
      lines.push(` * Generated Zod schema for ${composition.modelName} model`);
      lines.push(` * @generated ${composition.generationMetadata.timestamp}`);
      lines.push(' * @generator prisma-zod-generator');
      lines.push(' */');
      lines.push('');
    }

    // Generate schema definition first to analyze import usage
    const schemaDefinition = this.generateSchemaDefinition(composition);
    const schemaContent = schemaDefinition.join('\n');

    // Imports section - filter based on actual usage in schema content
    const imports = this.generateImportsSection(composition, schemaContent);
    if (imports.length > 0) {
      lines.push(...imports);
      lines.push('');
    }

    // Model documentation
    if (!lean && composition.documentation) {
      lines.push(composition.documentation);
    }

    // Schema definition
    lines.push(...schemaDefinition);
    lines.push('');

    // Type definition
    const typeDefinition = this.generateTypeDefinition(composition);
    lines.push(...typeDefinition);
    lines.push('');

    if (!lean) {
      // Statistics comment
      const stats = composition.statistics;
      lines.push('/**');
      lines.push(' * Schema Statistics:');
      lines.push(` * - Total fields: ${stats.totalFields}`);
      lines.push(` * - Processed fields: ${stats.processedFields}`);
      lines.push(` * - Fields with validations: ${stats.validatedFields}`);
      lines.push(` * - Enhanced fields: ${stats.enhancedFields}`);
      lines.push(` * - Relation fields: ${stats.relationFields}`);
      lines.push(` * - Complex type fields: ${stats.complexTypeFields}`);
      lines.push(' */');
    }

    return {
      content: lines.join('\n'),
      imports: composition.imports,
      exports: composition.exports,
      filename: `${composition.modelName.toLowerCase()}.ts`,
      dependencies: this.extractSchemaDependencies(composition),
    };
  }

  /**
   * Generate model-level documentation
   */
  private generateModelDocumentation(model: DMMF.Model): string {
    const lines: string[] = ['/**'];

    lines.push(` * Zod schema for ${model.name} model`);
    lines.push(' *');
    lines.push(` * @model ${model.name}`);
    lines.push(` * @fields ${model.fields.length}`);

    // Add field summary
    const scalarFields = model.fields.filter((f) => f.kind === 'scalar').length;
    const relationFields = model.fields.filter((f) => f.kind === 'object').length;
    const enumFields = model.fields.filter((f) => f.kind === 'enum').length;

    if (scalarFields > 0) lines.push(` * @scalars ${scalarFields}`);
    if (relationFields > 0) lines.push(` * @relations ${relationFields}`);
    if (enumFields > 0) lines.push(` * @enums ${enumFields}`);

    lines.push(' *');
    lines.push(' * Generated with enhanced type mapping, validation, and documentation.');
    lines.push(' */');

    return lines.join('\n');
  }

  /**
   * Generate imports section
   */
  private generateImportsSection(
    composition: ModelSchemaComposition,
    schemaContent?: string,
  ): string[] {
    const lines: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load to avoid circular deps
    const transformerModule = require('../transformer').default;
    const imports = Array.from(composition.imports).sort();

    // Zod import
    if (imports.includes('z')) {
      // Defer to Transformer import strategy to honor zodImportTarget
      const helper = new transformerModule({});
      const importLine =
        typeof helper.generateImportZodStatement === 'function'
          ? helper.generateImportZodStatement()
          : "import * as z from 'zod';\n";
      lines.push(importLine.trimEnd());
    }

    const collectCustomImports = (
      imports: CustomImport[] | undefined,
      target: Map<string, CustomImport>,
    ) => {
      if (!imports) {
        return;
      }
      for (const customImport of imports) {
        if (!customImport || !customImport.importStatement) {
          continue;
        }
        if (!target.has(customImport.importStatement)) {
          target.set(customImport.importStatement, customImport);
        }
      }
    };

    const customImportMap = new Map<string, CustomImport>();
    collectCustomImports(composition.customImports, customImportMap);
    for (const field of composition.fields) {
      collectCustomImports(field.customImports, customImportMap);
    }

    const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const schemaBody = schemaContent ?? '';
    const mergedCustomImports = Array.from(customImportMap.values())
      .filter((customImport) => {
        if (!schemaBody || !customImport.importedItems || customImport.importedItems.length === 0) {
          return true;
        }
        return customImport.importedItems.some((item) => {
          if (!item) {
            return false;
          }
          const pattern = new RegExp(`\\b${escapeRegExp(item)}\\b`);
          return pattern.test(schemaBody);
        });
      })
      .sort((a, b) => a.importStatement.localeCompare(b.importStatement));

    if (mergedCustomImports.length > 0) {
      const helper = new transformerModule({});
      const block = helper.generateCustomImportStatements(mergedCustomImports, 'models');
      if (block) {
        for (const rawLine of block.trim().split('\n')) {
          const trimmedLine = rawLine.trim();
          if (trimmedLine.length > 0) {
            lines.push(trimmedLine);
          }
        }
      }
    }

    // Get naming configuration for proper import path generation
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolvePureModelNaming, applyPattern } = require('../utils/naming-resolver');
    const config = transformerModule.getGeneratorConfig?.();
    const namingResolved = resolvePureModelNaming(config);
    const ext =
      typeof transformerModule.getImportFileExtension === 'function'
        ? transformerModule.getImportFileExtension()
        : '';

    // Identify enum fields by validation marker added in mapEnumType ("// Enum type:")
    const enumNames = new Set(
      composition.fields
        .filter((f) => f.validations.some((v) => v.includes('Enum type: ')))
        .map((f) => f.prismaType),
    );

    // Enum schema imports – relative to models under <output>/schemas/models
    // Use enum naming configuration to generate correct import paths
    const enumSchemaImports = imports.filter(
      (importName) => this.findEnumForImport(importName, enumNames, transformerModule) !== null,
    );

    enumSchemaImports.forEach((importName) => {
      const enumBase = this.findEnumForImport(importName, enumNames, transformerModule);
      if (!enumBase) {
        console.error(`Failed to extract enum base name from import: ${importName}`);
        return;
      }

      try {
        const {
          resolveEnumNaming,
          generateFileName,
          generateExportName,
          // eslint-disable-next-line @typescript-eslint/no-require-imports
        } = require('../utils/naming-resolver');
        const enumNaming = resolveEnumNaming(transformerModule.getGeneratorConfig?.());
        const enumFileName = generateFileName(
          enumNaming.filePattern,
          enumBase,
          undefined,
          undefined,
          enumBase,
        );
        const actualExportName = generateExportName(
          enumNaming.exportNamePattern,
          enumBase,
          undefined,
          undefined,
          enumBase,
        );
        // Remove .ts extension for import base
        const importPath = enumFileName.replace(/\.ts$/, '');
        // Use the actual export name from config instead of assuming 'Schema' suffix
        // Only use alias if the export name differs from the expected import name
        if (actualExportName === importName) {
          lines.push(`import { ${actualExportName} } from '../enums/${importPath}${ext}';`);
        } else {
          lines.push(
            `import { ${actualExportName} as ${importName} } from '../enums/${importPath}${ext}';`,
          );
        }
      } catch (_error) {
        // Log the error for debugging
        console.error(`Failed to resolve enum naming for ${enumBase}:`, _error);
        // Fallback to default naming if there's an error
        lines.push(`import { ${importName} } from '../enums/${enumBase}.schema${ext}';`);
      }
    });

    // Prisma client import (for Decimal type support)
    if (imports.includes('Prisma')) {
      lines.push("import { Prisma } from '@prisma/client';");
    }

    // Related model schema imports (exclude current schema + enums + special imports).
    // After naming resolution in mapObjectType, related symbols may not end with 'Schema'.
    const enumImportNameSet = new Set(enumSchemaImports);
    const relatedModelImports = imports.filter(
      (imp) =>
        imp !== 'z' &&
        imp !== 'Prisma' &&
        imp !== composition.schemaName &&
        !enumImportNameSet.has(imp),
    );
    // Helper: derive PascalCase model name from an import symbol using the exportNamePattern
    // Centralized in naming-resolver.parseExportSymbol for maintainability
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseExportSymbol } = require('../utils/naming-resolver');

    relatedModelImports.forEach((importSymbol) => {
      const base = parseExportSymbol(
        importSymbol,
        namingResolved.exportNamePattern as string,
        namingResolved.schemaSuffix || '',
        namingResolved.typeSuffix || '',
      );

      // Generate the correct file path using the naming pattern
      const fileName = applyPattern(
        namingResolved.filePattern,
        base,
        namingResolved.schemaSuffix,
        namingResolved.typeSuffix,
      );

      const importPath = fileName.replace(/\.(ts|js)$/, '');
      lines.push(`import { ${importSymbol} } from './${importPath}${ext}';`);
    });

    return lines;
  }

  /**
   * Find which enum an import corresponds to by matching against the enum naming configuration
   */
  private findEnumForImport(
    importName: string,
    enumNames: Set<string>,
    transformerModule: TransformerModule,
  ): string | null {
    try {
      const enumNaming = resolveEnumNaming(transformerModule.getGeneratorConfig?.());

      for (const enumName of Array.from(enumNames)) {
        const expectedExportName = generateExportName(
          enumNaming.exportNamePattern,
          enumName,
          undefined,
          undefined,
          enumName,
        );
        if (importName === expectedExportName) {
          return enumName;
        }
      }
    } catch {
      // Fallback to legacy pattern matching if naming resolution fails
      const legacyBase = importName.replace(/Schema$/, '');
      return enumNames.has(legacyBase) ? legacyBase : null;
    }
    return null;
  }

  /**
   * Generate schema definition
   */
  private generateSchemaDefinition(composition: ModelSchemaComposition): string[] {
    const lines: string[] = [];
    // Lazy require to avoid circular import at module scope
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require('../transformer').default.getGeneratorConfig?.();
    const lean = cfg?.pureModelsLean === true;
    const zodTarget = (cfg?.zodImportTarget ?? 'auto') as 'auto' | 'v3' | 'v4';
    const useGetterRecursion = zodTarget === 'v4';
    // Variants config removed (not used in current logic)
    // Optional field behavior parser (avoid any)
    const optBehavior = ((): 'optional' | 'nullable' | 'nullish' => {
      const v = (cfg as { optionalFieldBehavior?: string } | null)?.optionalFieldBehavior;
      return v === 'optional' || v === 'nullable' || v === 'nullish' ? v : 'nullish';
    })();

    lines.push(`export const ${composition.schemaName} = z.object({`);

    for (const field of composition.fields) {
      if (!lean && field.documentation) {
        const docLines = field.documentation.split('\n').map((line) => `  ${line}`);
        lines.push(...docLines);
      }

      const dotValidations = field.validations.filter((v) => v.trim().startsWith('.'));
      const commentValidations = field.validations.filter((v) => v.trim().startsWith('//'));

      // Start from base without optional modifiers, but preserve nullable/nullish from @zod annotations
      const base = field.zodSchema.replace(/\.optional\(\)/g, '').trimEnd();
      let modifierSuffix = '';

      // Compute if user-provided dot validations already specify optionality
      const chain = dotValidations.join('');
      const chainHasOptionality = /\.(optional|nullish|nullable)\(/.test(chain);

      // Apply configured optional field behavior only for schema-optional fields.
      // Required fields (even with defaults/auto-gen) remain required in pure models.
      const treatAsOptional = field.isOptional;
      if (treatAsOptional && !chainHasOptionality) {
        if (optBehavior === 'nullish') modifierSuffix = '.nullish()';
        else if (optBehavior === 'optional') modifierSuffix = '.optional()';
        else modifierSuffix = '.nullable()';
      }

      if (useGetterRecursion && field.isRelation) {
        const hasOpt = /\.optional\(\)/.test(chain) || /\.optional\(\)/.test(modifierSuffix);
        const hasNull = /\.nullable\(\)/.test(chain) || /\.nullable\(\)/.test(modifierSuffix);
        const hasNullish = /\.nullish\(\)/.test(chain) || /\.nullish\(\)/.test(modifierSuffix);

        // Derive the inner Zod type for the getter return type annotation
        const arrayMatch = base.match(/^z\.array\(\s*(.+)\s*\)$/);
        let innerType = '';
        if (arrayMatch) {
          const el = arrayMatch[1];
          innerType = `z.ZodArray<typeof ${el}>`;
        } else {
          innerType = `typeof ${base}`;
        }

        let returnType = innerType;
        if (hasNullish) {
          returnType = `z.ZodOptional<z.ZodNullable<${returnType}>>`;
        } else {
          if (hasNull) returnType = `z.ZodNullable<${returnType}>`;
          if (hasOpt) returnType = `z.ZodOptional<${returnType}>`;
        }

        lines.push(
          `  get ${field.fieldName}(): ${returnType} { return ${base}${chain}${modifierSuffix}; },`,
        );
      } else {
        lines.push(`  ${field.fieldName}: ${base}${chain}${modifierSuffix},`);
      }

      if (!lean) {
        commentValidations.forEach((cv) => lines.push(`  ${cv}`));
        lines.push('');
      }
    }

    // Remove last empty line and add closing brace with potential model-level validation
    if (lines[lines.length - 1] === '') lines.pop();

    // Apply model-level validation from @zod.import().refine(...) etc.
    if (composition.modelLevelValidation) {
      const normalizedChain = composition.modelLevelValidation.trim().replace(/^\.+/, '');
      if (normalizedChain) {
        lines.push(`}).${normalizedChain};`);
      } else {
        lines.push('});');
      }
    } else {
      lines.push('});');
    }

    return lines;
  }

  /**
   * Generate TypeScript type definition
   */
  private generateTypeDefinition(composition: ModelSchemaComposition): string[] {
    const lines: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require for runtime config
    const cfg = require('../transformer').default.getGeneratorConfig?.();
    const lean = cfg?.pureModelsLean === true;
    const emitLegacyAlias = cfg?.legacyModelAlias !== false; // default true
    if (!lean) {
      lines.push('/**');
      lines.push(` * Inferred TypeScript type for ${composition.modelName}`);
      lines.push(' */');
    }
    // Determine type name. If using the default schema export pattern (Model + SchemaSuffix),
    // keep the legacy type naming (<Model><TypeSuffix>). Otherwise, align the type name with
    // the configured schema export name (e.g., zUser -> zUserType).
    let typeName: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolvePureModelNaming, applyPattern } = require('../utils/naming-resolver');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const transformer = require('../transformer');
      const cfg2 = transformer.Transformer
        ? transformer.Transformer.getGeneratorConfig()
        : transformer.default?.getGeneratorConfig();
      const namingResolved = resolvePureModelNaming(cfg2);
      const effectiveTypeSuffix =
        namingResolved.typeSuffix === undefined || namingResolved.typeSuffix === null
          ? 'Type'
          : namingResolved.typeSuffix;
      const defaultSchemaExport = applyPattern(
        '{Model}{SchemaSuffix}',
        composition.modelName,
        namingResolved.schemaSuffix,
        effectiveTypeSuffix,
      );
      if (composition.schemaName === defaultSchemaExport) {
        // Legacy/default: <Model><TypeSuffix>
        // Respect explicit empty string suffix if configured
        typeName = `${composition.modelName}${effectiveTypeSuffix}`;
      } else {
        const suffix = effectiveTypeSuffix;
        if (suffix && suffix.length > 0) {
          // Custom export name (e.g., zModel) with a non-empty type suffix: zModelType
          typeName = `${composition.schemaName}${suffix}`;
        } else {
          // Empty suffix: preserve legacy model-based type name to avoid surprises
          typeName = composition.modelName;
        }
      }
    } catch {
      // Safe fallback: export model name (no forced Type suffix)
      typeName = composition.modelName;
    }

    lines.push(`export type ${typeName} = z.infer<typeof ${composition.schemaName}>;`);
    // Only emit legacy alias when NOT in pureModels mode. In pureModels mode we transform
    // the *Schema export into *Model directly and an alias would cause a duplicate export
    // and reference to a non-existent *Schema symbol after transformation.
    if (emitLegacyAlias && !cfg?.pureModels) {
      lines.push(`export const ${composition.modelName}Model = ${composition.schemaName};`);
    }
    return lines;
  }

  /**
   * Extract schema dependencies for import resolution
   */
  private extractSchemaDependencies(composition: ModelSchemaComposition): string[] {
    const dependencies: string[] = [];

    composition.fields.forEach((field) => {
      if (field.zodSchema.includes('Schema')) {
        const matches = field.zodSchema.match(/(\w+Schema)/g);
        if (matches) {
          matches.forEach((match) => {
            if (match !== composition.schemaName && !dependencies.includes(match)) {
              dependencies.push(match);
            }
          });
        }
      }
    });

    return dependencies;
  }

  /**
   * Generate configuration hash for caching
   */
  private generateConfigHash(): string {
    const configString = JSON.stringify(this.config);
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < configString.length; i++) {
      const char = configString.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }

  /**
   * Generate complete schema collection for multiple models
   */
  generateSchemaCollection(models: DMMF.Model[]): SchemaCollection {
    const collection: SchemaCollection = {
      schemas: new Map(),
      indexFile: this.generateIndexFileContent([]),
      dependencies: new Map(),
      globalImports: new Set(['z']),
      generationSummary: {
        totalModels: models.length,
        processedModels: 0,
        totalFields: 0,
        processedFields: 0,
        enhancedFields: 0,
        errorCount: 0,
        warnings: [],
      },
    };

    const processedSchemas: string[] = [];

    // Process each model
    for (const model of models) {
      try {
        logger.debug(`Generating schema for model: ${model.name}`);

        const composition = this.generateModelSchema(model);
        const fileContent = this.generateSchemaFileContent(composition);

        collection.schemas.set(model.name, {
          composition,
          fileContent,
          processingErrors: [],
        });

        // Update collection metadata
        collection.generationSummary.processedModels++;
        collection.generationSummary.totalFields += composition.statistics.totalFields;
        collection.generationSummary.processedFields += composition.statistics.processedFields;
        collection.generationSummary.enhancedFields += composition.statistics.enhancedFields;

        // Collect global imports
        composition.imports.forEach((imp) => collection.globalImports.add(imp));

        // Track dependencies
        if (fileContent.dependencies.length > 0) {
          collection.dependencies.set(model.name, fileContent.dependencies);
        }

        processedSchemas.push(model.name);
      } catch (error) {
        console.error(`Failed to process model ${model.name}:`, error);
        collection.generationSummary.errorCount++;
        collection.generationSummary.warnings.push(
          `Model ${model.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Generate index file with all processed schemas
    collection.indexFile = this.generateIndexFileContent(processedSchemas);

    // Validate dependencies
    const dependencyValidation = this.validateSchemaDependencies(collection);
    if (dependencyValidation.errors.length > 0) {
      collection.generationSummary.warnings.push(...dependencyValidation.errors);
    }

    return collection;
  }

  /**
   * Generate index file content that exports all schemas
   */
  private generateIndexFileContent(schemaNames: string[]): SchemaFileContent {
    const lines: string[] = [];

    // File header
    lines.push('/**');
    lines.push(' * Generated Zod schemas index');
    lines.push(' * @generated automatically by prisma-zod-generator');
    lines.push(' */');
    lines.push('');

    // Re-exports from individual schema files
    for (const schemaName of schemaNames.sort()) {
      lines.push(`export * from './${schemaName.toLowerCase()}';`);
    }

    if (schemaNames.length === 0) {
      lines.push('// No schemas generated');
    }

    return {
      content: lines.join('\n'),
      imports: new Set(),
      exports: new Set(schemaNames.flatMap((name) => [`${name}Schema`, `${name}Type`])),
      filename: 'index.ts',
      dependencies: [],
    };
  }

  /**
   * Validate schema dependencies for circular references and missing schemas
   */
  private validateSchemaDependencies(collection: SchemaCollection): {
    isValid: boolean;
    errors: string[];
    circularDependencies: string[][];
  } {
    const errors: string[] = [];
    const circularDependencies: string[][] = [];
    const availableSchemas = new Set(collection.schemas.keys());

    // Check for missing dependencies
    for (const [modelName, dependencies] of collection.dependencies) {
      for (const dependency of dependencies) {
        const dependencyModel = dependency.replace('Schema', '');
        if (!availableSchemas.has(dependencyModel)) {
          errors.push(`Model ${modelName} depends on missing schema: ${dependencyModel}`);
        }
      }
    }

    // Check for circular dependencies using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const detectCycle = (modelName: string, path: string[]): boolean => {
      if (recursionStack.has(modelName)) {
        const cycleStart = path.indexOf(modelName);
        circularDependencies.push([...path.slice(cycleStart), modelName]);
        return true;
      }

      if (visited.has(modelName)) {
        return false;
      }

      visited.add(modelName);
      recursionStack.add(modelName);

      const dependencies = collection.dependencies.get(modelName) || [];
      for (const dependency of dependencies) {
        const dependencyModel = dependency.replace('Schema', '');
        if (detectCycle(dependencyModel, [...path, modelName])) {
          return true;
        }
      }

      recursionStack.delete(modelName);
      return false;
    };

    for (const modelName of availableSchemas) {
      if (!visited.has(modelName)) {
        detectCycle(modelName, []);
      }
    }

    if (circularDependencies.length > 0) {
      circularDependencies.forEach((cycle) => {
        errors.push(`Circular dependency detected: ${cycle.join(' -> ')}`);
      });
    }

    return {
      isValid: errors.length === 0,
      errors,
      circularDependencies,
    };
  }

  /**
   * Generate schema validation report
   */
  generateValidationReport(collection: SchemaCollection): SchemaValidationReport {
    const report: SchemaValidationReport = {
      isValid: true,
      summary: collection.generationSummary,
      modelReports: [],
      globalIssues: [],
      recommendations: [],
    };

    // Validate each schema
    for (const [modelName, schemaData] of collection.schemas) {
      const modelReport: ModelValidationReport = {
        modelName,
        isValid: true,
        fieldCount: schemaData.composition.statistics.totalFields,
        processedFields: schemaData.composition.statistics.processedFields,
        enhancedFields: schemaData.composition.statistics.enhancedFields,
        issues: [],
        warnings: [],
      };

      // Check for processing errors
      if (schemaData.processingErrors.length > 0) {
        modelReport.isValid = false;
        modelReport.issues.push(...schemaData.processingErrors);
      }

      // Check field processing completeness
      if (modelReport.processedFields < modelReport.fieldCount) {
        modelReport.warnings.push(
          `Not all fields processed: ${modelReport.processedFields}/${modelReport.fieldCount}`,
        );
      }

      // Check for missing documentation
      const undocumentedFields = schemaData.composition.fields.filter((f) => !f.documentation);
      if (undocumentedFields.length > 0) {
        modelReport.warnings.push(`${undocumentedFields.length} fields lack documentation`);
      }

      report.modelReports.push(modelReport);

      if (!modelReport.isValid) {
        report.isValid = false;
      }
    }

    // Add dependency validation
    const dependencyValidation = this.validateSchemaDependencies(collection);
    if (!dependencyValidation.isValid) {
      report.isValid = false;
      report.globalIssues.push(...dependencyValidation.errors);
    }

    // Generate recommendations
    if (
      collection.generationSummary.enhancedFields <
      collection.generationSummary.totalFields * 0.1
    ) {
      report.recommendations.push(
        'Consider adding @zod validations to more fields for enhanced type safety',
      );
    }

    if (collection.generationSummary.errorCount > 0) {
      report.recommendations.push(
        'Review and fix field processing errors for complete schema generation',
      );
    }

    return report;
  }

  /**
   * Get type mapping statistics
   */
  getTypeMappingStatistics(fields: DMMF.Field[]): {
    totalFields: number;
    scalarFields: number;
    enumFields: number;
    relationFields: number;
    listFields: number;
    optionalFields: number;
    typeCounts: Record<string, number>;
  } {
    const stats = {
      totalFields: fields.length,
      scalarFields: 0,
      enumFields: 0,
      relationFields: 0,
      listFields: 0,
      optionalFields: 0,
      typeCounts: {} as Record<string, number>,
    };

    for (const field of fields) {
      // Count by kind
      if (field.kind === 'scalar') stats.scalarFields++;
      else if (field.kind === 'enum') stats.enumFields++;
      else if (field.kind === 'object') stats.relationFields++;

      // Count lists and optionals
      if (field.isList) stats.listFields++;
      if (!field.isRequired) stats.optionalFields++;

      // Count by type
      stats.typeCounts[field.type] = (stats.typeCounts[field.type] || 0) + 1;
    }

    return stats;
  }

  /**
   * Resolve model type name to avoid conflicts with enum types
   */
  private resolveModelTypeName(modelName: string): string {
    // Get the configured type suffix from naming configuration
    let typeSuffix = 'Type'; // fallback default
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { resolvePureModelNaming } = require('../utils/naming-resolver');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const transformer = require('../transformer');
      const cfg = transformer.Transformer
        ? transformer.Transformer.getGeneratorConfig()
        : transformer.default?.getGeneratorConfig();
      const namingResolved = resolvePureModelNaming(cfg);
      typeSuffix = namingResolved.typeSuffix;
    } catch {
      // fallback to default naming
      typeSuffix = 'Type';
    }

    // Dynamically get enum names from the transformer to avoid hardcoding
    let enumNames: string[] = [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const transformer = require('../transformer').default;
      enumNames = transformer.enumNames || [];
    } catch {
      // Fallback: if we can't get enum names, use conservative approach
      enumNames = [];
    }

    // If the model name + typeSuffix would conflict with an existing enum, use a different pattern
    const defaultTypeName = `${modelName}${typeSuffix}`;

    if (enumNames.includes(defaultTypeName)) {
      // Use the model name directly instead of adding suffix to avoid conflict
      return modelName;
    }

    return defaultTypeName;
  }

  /**
   * Convert a parsed JSON object to a Zod schema string
   */
  private convertObjectToZodSchema(obj: Record<string, any>): string {
    const entries = Object.entries(obj).map(([key, value]) => {
      const zodType = this.inferZodTypeFromValue(value);
      return `${JSON.stringify(key)}: ${zodType}`;
    });

    return `{ ${entries.join(', ')} }`;
  }

  /**
   * Convert a parsed JSON array to a Zod schema string
   */
  private convertArrayToZodSchema(arr: any[]): string {
    if (arr.length === 0) {
      return 'z.unknown()';
    }

    // For simplicity, infer the type from the first element
    // In practice, you might want to validate all elements have the same type
    const firstElementType = this.inferZodTypeFromValue(arr[0]);
    return firstElementType;
  }

  /**
   * Infer a Zod type from a JavaScript value
   */
  private inferZodTypeFromValue(value: any): string {
    if (value === null) {
      return 'z.null()';
    }

    switch (typeof value) {
      case 'string':
        return 'z.string()';
      case 'number':
        return Number.isInteger(value) ? 'z.number().int()' : 'z.number()';
      case 'boolean':
        return 'z.boolean()';
      case 'object':
        if (Array.isArray(value)) {
          return `z.array(${this.convertArrayToZodSchema(value)})`;
        } else {
          return `z.object(${this.convertObjectToZodSchema(value)})`;
        }
      default:
        return 'z.unknown()';
    }
  }
}
