import {
  ArgumentDefinition,
  Directive,
  DirectiveDefinition,
  EnumType,
  InputFieldDefinition,
  InputObjectType,
  InterfaceType,
  isInputObjectType,
  isNonNullType,
  NamedSchemaElement,
  ObjectType,
  Schema,
  sourceASTs,
  Type,
  UnionType,
  VariableDefinitions
} from "./definitions";
import { ASTNode, GraphQLError, isValidNameError } from "graphql";
import { isValidValue } from "./values";
import { isIntrospectionName } from "./introspection";
import { isSubtype, sameType } from "./types";

// Note really meant to be called manually as it is part of `Schema.validate`, but separated for core-organization reasons.
// This mostly apply the validations that graphQL-js does in `validateSchema` which we don't reuse because it applies to
// a `GraphQLSchema` (but note that the bulk of the validation is done by `validateSDL` which we _do_ reuse in `Schema.validate`).
export function validateSchema(schema: Schema): GraphQLError[] {
  // TODO: There is quite a few more needed additional graphqQL validations.
  return new Validator(schema).validate();
}

class InputObjectCircularRefsValidator {
  private readonly visitedTypes = new Set<string>();
  // Array of types nodes used to produce meaningful errors
  private readonly fieldPath: InputFieldDefinition[] = [];
  // Position in the field path
  private readonly fieldPathIndexByTypeName = new Map<string, number>();

  constructor(private readonly onError: (error: GraphQLError) => void) {
  }

  detectCycles(type: InputObjectType) {
    if (this.visitedTypes.has(type.name)) {
      return;
    }

    this.visitedTypes.add(type.name);
    this.fieldPathIndexByTypeName.set(type.name, this.fieldPath.length);

    for (const field of type.fields()) {
      if (isNonNullType(field.type!) && isInputObjectType(field.type.ofType)) {
        const fieldType = field.type.ofType;
        const cycleIndex = this.fieldPathIndexByTypeName.get(fieldType.name);

        this.fieldPath.push(field);
        if (cycleIndex === undefined) {
          this.detectCycles(fieldType);
        } else {
          const cyclePath = this.fieldPath.slice(cycleIndex);
          const pathStr = cyclePath.map((fieldObj) => fieldObj.name).join('.');
          this.onError(new GraphQLError(
            `Cannot reference Input Object "${fieldType.name}" within itself through a series of non-null fields: "${pathStr}".`,
            sourceASTs(...cyclePath)
          ));
        }
        this.fieldPath.pop();
      }
    }
    this.fieldPathIndexByTypeName.delete(type.name);
  }
}

class Validator {
  private readonly emptyVariables = new VariableDefinitions();
  private hasMissingTypes: boolean = false;
  private readonly errors: GraphQLError[] = [];

  constructor(readonly schema: Schema) {}

  validate(): GraphQLError[] {
    for (const type of this.schema.types()) {
      this.validateName(type);
      switch (type.kind) {
        case 'ObjectType':
        case 'InterfaceType':
          this.validateObjectOrInterfaceType(type);
          break;
        case 'InputObjectType':
          this.validateInputObjectType(type);
          break;
        case 'UnionType':
          this.validateUnionType(type);
          break;
        case 'EnumType':
          this.validateEnumType(type);
          break;
      }
    }

    for (const directive of this.schema.allDirectives()) {
      this.validateName(directive);
      for (const arg of directive.arguments()) {
        this.validateArg(arg);
      }
      for (const application of directive.applications()) {
        this.validateDirectiveApplication(directive, application)
      }
    }

    // We do the interface implementation and input object cycles validation after we've validated
    // all types, because both of those checks reach into other types than the one directly checked
    // so we want to make sure all types are properly set. That is also why we skip those checks if
    // we found any type missing (in which case, there will be some errors and users should fix those
    // first).
    if (!this.hasMissingTypes) {
      const refsValidator = new InputObjectCircularRefsValidator(e => this.errors.push(e));
      for (const type of this.schema.types()) {
        switch (type.kind) {
          case 'ObjectType':
          case 'InterfaceType':
            this.validateImplementedInterfaces(type);
            break;
          case 'InputObjectType':
            refsValidator.detectCycles(type);
            break;
        }
      }
    }

    return this.errors;
  }

  private validateHasType(elt: { type?: Type, coordinate: string, sourceAST?: ASTNode }) {
    // Note that this error can't happen if you parse the schema since it wouldn't be valid syntax, but it can happen for
    // programmatically constructed schema.
    if (!elt.type) {
      this.errors.push(new GraphQLError(`Element ${elt.coordinate} does not have a type set`, elt.sourceAST));
      this.hasMissingTypes = false;
    }
  }

  private validateName(elt: { name: string, sourceAST?: ASTNode}) {
    if (isIntrospectionName(elt.name)) {
      return;
    }
    const error = isValidNameError(elt.name);
    if (error) {
      this.errors.push(elt.sourceAST ? new GraphQLError(error.message, elt.sourceAST) : error);
    }
  }

  private validateObjectOrInterfaceType(type: ObjectType | InterfaceType) {
    if (!type.hasFields(true)) {
      this.errors.push(new GraphQLError(`Type ${type.name} must define one or more fields.`, type.sourceAST));
    }
    for (const field of type.fields()) {
      this.validateName(field);
      this.validateHasType(field);
      for (const arg of field.arguments()) {
        this.validateArg(arg);
      }
    }
  }

  private validateImplementedInterfaces(type: ObjectType | InterfaceType) {
    if (type.implementsInterface(type.name)) {
      this.errors.push(new GraphQLError(
        `Type ${type} cannot implement itself because it would create a circular reference.`,
        sourceASTs(type, type.interfaceImplementation(type.name)!)
      ));
    }

    for (const itf of type.interfaces()) {
      for (const itfField of itf.fields()) {
        const field = type.field(itfField.name);
        if (!field) {
          this.errors.push(new GraphQLError(
            `Interface field ${itfField.coordinate} expected but ${type} does not provide it.`,
            sourceASTs(itfField, type)
          ));
          continue;
        }
        // Note that we may not have validated the interface yet, so making sure we have a meaningful error
        // if the type is not set, even if that means a bit of cpu wasted since we'll re-check later (and
        // as many type as the interface is implemented); it's a cheap check anyway.
        this.validateHasType(itfField);
        if (!isSubtype(itfField.type!, field.type!)) {
          this.errors.push(new GraphQLError(
            `Interface field ${itfField.coordinate} expects type ${itfField.type} but ${field.coordinate} of type ${field.type} is not a proper subtype.`,
            sourceASTs(itfField, field)
          ));
        }

        for (const itfArg of itfField.arguments()) {
          const arg = field.argument(itfArg.name);
          if (!arg) {
            this.errors.push(new GraphQLError(
              `Interface field argument ${itfArg.coordinate} expected but ${field.coordinate} does not provide it.`,
              sourceASTs(itfArg, field)
            ));
            continue;
          }
          // Same as above for the field
          this.validateHasType(itfArg);
          // Note that we could use contra-variance but as graphQL-js currently doesn't allow it, we mimic that.
          if (!sameType(itfArg.type!, arg.type!)) {
            this.errors.push(new GraphQLError(
              `Interface field argument ${itfArg.coordinate} expects type ${itfArg.type} but ${arg.coordinate} is type ${arg.type}.`,
              sourceASTs(itfArg, arg)
            ));
          }
        }

        for (const arg of field.arguments()) {
          // Now check arguments on the type field that are not in the interface. They should not be required.
          if (itfField.argument(arg.name)) {
            continue;
          }
          if (arg.isRequired()) {
            this.errors.push(new GraphQLError(
              `Field ${field.coordinate} includes required argument ${arg.name} that is missing from the Interface field ${itfField.coordinate}.`,
              sourceASTs(arg, itfField)
            ));
          }
        }
      }

      // Now check that this type also declare implementations of all the interfaces of its interface.
      for (const itfOfItf of itf.interfaces()) {
        if (!type.implementsInterface(itfOfItf)) {
          if (itfOfItf === type) {
            this.errors.push(new GraphQLError(`Type ${type} cannot implement ${itf} because it would create a circular reference.`, sourceASTs(type, itf)));
          } else {
            this.errors.push(new GraphQLError(
              `Type ${type} must implement ${itfOfItf} because it is implemented by ${itf}.`,
              sourceASTs(type, itf, itfOfItf)
            ));
          }
        }
      }
    }
  }

  private validateInputObjectType(type: InputObjectType) {
    if (!type.hasFields()) {
      this.errors.push(new GraphQLError(`Input Object type ${type.name} must define one or more fields.`, type.sourceAST));
    }
    for (const field of type.fields()) {
      this.validateName(field);
      this.validateHasType(field);
      if (field.isRequired() && field.isDeprecated()) {
        this.errors.push(new GraphQLError(
          `Required input field ${field.coordinate} cannot be deprecated.`,
          sourceASTs(field.appliedDirectivesOf('deprecated')[0], field)
        ));
      }
    }
  }

  private validateArg(arg: ArgumentDefinition<any>) {
    this.validateName(arg);
    this.validateHasType(arg);
    if (arg.isRequired() && arg.isDeprecated()) {
      this.errors.push(new GraphQLError(
        `Required argument ${arg.coordinate} cannot be deprecated.`,
        sourceASTs(arg.appliedDirectivesOf('deprecated')[0], arg)
      ));
    }
  }

  private validateUnionType(type: UnionType) {
    if (type.membersCount() === 0) {
      this.errors.push(new GraphQLError(`Union type ${type.coordinate} must define one or more member types.`, type.sourceAST));
    }
  }

  private validateEnumType(type: EnumType) {
    if (type.values.length === 0) {
      this.errors.push(new GraphQLError(`Enum type ${type.coordinate} must define one or more values.`, type.sourceAST));
    }
    for (const value of type.values) {
      this.validateName(value);
      if (value.name === 'true' || value.name === 'false' || value.name === 'null') {
        this.errors.push(new GraphQLError(
          `Enum type ${type.coordinate} cannot include value: ${value}.`,
          value.sourceAST
        ));
      }
    }
  }

  private validateDirectiveApplication(definition: DirectiveDefinition, application: Directive) {
    // Note that graphQL `validateSDL` method will already have validated that we only have
    // known arguments and that that we don't miss a required argument. What remains is to
    // ensure each provided value if valid for the argument type.
    for (const argument of definition.arguments()) {
      const value = application.arguments()[argument.name];
      if (!value) {
        // Again, that implies that value is not required.
        continue;
      }
      if (!isValidValue(value, argument, this.emptyVariables)) {
        const parent = application.parent;
        // The only non-named SchemaElement is the `schema` definition.
        const parentDesc = parent instanceof NamedSchemaElement
          ? parent.coordinate
          : 'schema';
        this.errors.push(new GraphQLError(
          `Invalid value for "${argument.coordinate}" of type "${argument.type}" in application of "${definition.coordinate}" to "${parentDesc}".`,
          sourceASTs(application, argument)
        ));
      }
    }
  }
}
