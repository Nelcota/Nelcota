import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/workspace/guided";

const en: Messages<typeof ptBR> = {
  progress: "Creation steps",
  step: "Step {current} of {total}",
  next: "Continue",
  back: "Back",
  review: "Review before creating",
  technical: "Advanced options and SQL",
  problems: {
    required: "Enter a name to continue.",
    long: "This name is too long. Choose a shorter name.",
    invalid: "This name contains an invalid character.",
    duplicate: "A field already has this name.",
    exists: "A table already has this name.",
  },
  access: {
    who: "Who can access through the app?",
    what: "What can they do?",
    audiences: {
      private: {
        label: "Only my server",
        hint: "Start with private access. You can allow app access later in Access policies.",
      },
      owner: {
        label: "Each user, only their own records",
        hint: "People must sign in and can only access records linked to their user.",
      },
      signedIn: {
        label: "Anyone signed in to the app",
        hint: "All signed-in users access the same records, including other people’s records.",
      },
      everyone: {
        label: "Anyone, even without signing in",
        hint: "Records become publicly readable through your app’s API.",
      },
    },
    levels: { read: "Only view records", full: "View, create, edit and delete" },
    publicReadOnly: "Public access in this assistant allows reading only.",
    protected:
      "Record protection stays enabled. The required permissions are configured with the rule.",
    ownerAdded:
      "We will add user_id to identify the owner. When a user creates a record through the app, this field will be filled with their ID.",
    ownerConflict:
      "The existing user_id field must have the “User ID” type to use this option. Change its type in Fields or choose another access option.",
    summary: {
      private:
        "Only your server will have access. Visitors and app users will not be granted access.",
      owner: "Each signed-in user will be able to {actions} only their own records.",
      signedIn: "Any signed-in user will be able to {actions} all records.",
      everyone: "Anyone will be able to view all records, even without signing in.",
    },
    actions: { read: "view", full: "view, create, edit and delete" },
  },
  table: {
    description: "Build your table in four steps. No SQL required.",
    steps: { name: "Start", fields: "Fields", access: "Access", review: "Review" },
    startTitle: "What do you want to store?",
    startHint: "A table organizes records of the same kind, such as products, tasks or contacts.",
    template: "Start with an example",
    templates: { blank: "From scratch", notes: "Notes", tasks: "Tasks", products: "Products" },
    templateHint:
      "The example fills in initial fields. You can change everything in the next step.",
    name: "Table name",
    nameHint: "Choose a recognizable name, such as tasks or products.",
    fieldsTitle: "What information will each record have?",
    fieldsHint:
      "Each field stores one piece of information. A product might have a name and a price.",
    fieldTitle: "Field {number}",
    fieldName: "Field name",
    fieldPlaceholder: "e.g. name",
    fieldType: "Information type",
    required: "Required field",
    add: "Add field",
    remove: "Remove field {number}",
    automatic:
      "We have included an identifier (id) and creation date (created_at), both filled automatically.",
    accessTitle: "Who will use this data?",
    accessHint: "Choose initial access. You can create more rules later.",
    reviewHint:
      "Check the fields and access. Your table will be created empty and ready for records.",
    fieldsCount: "{count} fields",
    automaticField: "Automatic",
    optional: "Optional",
    requiredField: "Required",
    types: {
      text: "Text",
      bigint: "Whole number",
      numeric: "Decimal number",
      boolean: "Yes or no",
      date: "Date",
      timestamptz: "Date and time",
      uuid: "User ID",
      jsonb: "Structured data (JSON)",
    },
    examples: {
      text: "E.g. name, description or email.",
      bigint: "E.g. number of items: 10.",
      numeric: "E.g. price: 29.90.",
      boolean: "E.g. completed task: yes or no.",
      date: "E.g. date of birth.",
      timestamptz: "E.g. appointment time.",
      uuid: "An app user’s identifier.",
      jsonb: "A list or set of related information.",
    },
    advancedHint:
      "Adjust types, defaults, relationships and permissions here. The access choices above will no longer be applied.",
    customAccess:
      "Access will be defined by the advanced permissions and protection selected below.",
  },
  policy: {
    description: "Choose who can access and what they can do. We build the rule for you.",
    result: "What this rule does",
    details: "Rule name and SQL",
    ownerField: "Which field identifies the owner?",
    ownerHint: "Choose the field containing the ID of the user who owns the record.",
    addOwner: "Add a field to identify the owner",
    addOwnerHint:
      "The user_id field will be created with the rule. For new records, the app fills in the user’s ID automatically.",
    newOwnerReview:
      "The user_id field will be added. Existing records will have no owner; this rule only allows access after that field contains the correct user ID.",
    noOwner:
      "This table has no user ID field yet. Add a UUID field in the table’s Structure or choose another access option.",
    structure: "Open table structure",
    loading: "Checking table fields…",
    retry: "Try again",
    reviewHint:
      "This rule will be added to existing rules. Other rules may allow additional access.",
    ownerSummary:
      "The owner will be identified by {column}. Existing records must contain the user’s ID in this field.",
    name: "Rule name",
    nameHint: "We suggested a name. You can choose one that makes sense to you.",
    duplicate: "A rule already has this name. Choose another name.",
    advanced: "Write a rule with SQL",
    guided: "Return to the assistant",
    advancedHint:
      "For custom rules. You control the SQL expression, permissions and table protection.",
    activate: "Enable protection and configure required permissions",
    activateHint:
      "Permissions are added without removing existing ones. The rule and protection are saved together.",
    inactive: "Rules only filter records while table protection is enabled.",
    submit: "Create access rule",
  },
};

export default en;
