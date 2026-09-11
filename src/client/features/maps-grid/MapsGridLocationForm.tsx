import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  gridQueryKeys,
  type GridLocation,
} from "@/client/features/maps-grid/useMapsGridQueries";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  createFormValidationErrors,
  getFieldError,
  getFormError,
} from "@/client/lib/forms";
import {
  createGridLocation,
  updateGridLocation,
} from "@/serverFunctions/mapsGrid";

/**
 * The business a grid is centred on. Beyond the coordinates, every field here
 * feeds the matcher: brand name, domain, slug, phone, street and postal code are
 * what separate this office from the thirty others a multi-location brand puts
 * on the same map, and the match terms cover the aliases Google still shows.
 */

type LocationFormValues = {
  name: string;
  slug: string;
  lat: string;
  lng: string;
  radiusMiles: string;
  brandName: string;
  domain: string;
  phone: string;
  street: string;
  postalCode: string;
  matchTerms: string;
};

function formValues(location: GridLocation | null): LocationFormValues {
  return {
    name: location?.name ?? "",
    slug: location?.slug ?? "",
    lat: location ? String(location.lat) : "",
    lng: location ? String(location.lng) : "",
    radiusMiles: String(location?.radiusMiles ?? 5),
    brandName: location?.brandName ?? "",
    domain: location?.domain ?? "",
    phone: location?.phone ?? "",
    street: location?.street ?? "",
    postalCode: location?.postalCode ?? "",
    matchTerms: (location?.matchTerms ?? []).join(", "),
  };
}

function validate(values: LocationFormValues) {
  const fields: Record<string, string> = {};
  if (!values.name.trim()) fields.name = "Name the location.";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(values.slug.trim())) {
    fields.slug = "Lowercase letters, digits and dashes.";
  }
  if (!values.brandName.trim()) fields.brandName = "Brand name is required.";
  if (!values.domain.trim()) fields.domain = "Domain is required.";
  if (!Number.isFinite(Number(values.lat)) || values.lat.trim() === "") {
    fields.lat = "Latitude must be a number.";
  }
  if (!Number.isFinite(Number(values.lng)) || values.lng.trim() === "") {
    fields.lng = "Longitude must be a number.";
  }
  return Object.keys(fields).length > 0
    ? createFormValidationErrors({ fields })
    : null;
}

/** The form instance, so the field components below can take it as a prop. */
type LocationForm = ReturnType<typeof useLocationForm>;

function useLocationForm(input: {
  projectId: string;
  location: GridLocation | null;
  onDone: () => void;
}) {
  const { projectId, location, onDone } = input;
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: (values: LocationFormValues) => {
      const payload = {
        projectId,
        name: values.name.trim(),
        slug: values.slug.trim(),
        lat: Number(values.lat),
        lng: Number(values.lng),
        radiusMiles: Number(values.radiusMiles) || 5,
        brandName: values.brandName.trim(),
        domain: values.domain.trim(),
        phone: values.phone.trim() || null,
        street: values.street.trim() || null,
        postalCode: values.postalCode.trim() || null,
        matchTerms: values.matchTerms
          .split(",")
          .map((term) => term.trim())
          .filter(Boolean),
      };
      return location
        ? updateGridLocation({ data: { ...payload, locationId: location.id } })
        : createGridLocation({ data: payload });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: gridQueryKeys.locations(projectId),
      });
      toast.success(location ? "Location updated" : "Location added");
      onDone();
    },
  });

  return useForm({
    defaultValues: formValues(location),
    validators: { onSubmit: ({ value }) => validate(value) },
    onSubmit: async ({ formApi, value }) => {
      formApi.setErrorMap({ onSubmit: undefined });
      try {
        await saveMutation.mutateAsync(value);
      } catch (error) {
        formApi.setErrorMap({
          onSubmit: createFormValidationErrors({
            form: getStandardErrorMessage(error, "Couldn't save the location"),
          }),
        });
      }
    },
  });
}

export function MapsGridLocationForm(props: {
  projectId: string;
  location: GridLocation | null;
  onDone: () => void;
}) {
  const form = useLocationForm(props);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TextField
          form={form}
          name="name"
          label="Location name"
          placeholder="Uptown Office"
        />
        <TextField
          form={form}
          name="slug"
          label="Slug"
          placeholder="uptown"
          hint="Matched against /locations/<slug> on your site."
        />
        <TextField
          form={form}
          name="brandName"
          label="Brand name"
          placeholder="Airway Dentists"
        />
        <TextField
          form={form}
          name="domain"
          label="Domain"
          placeholder="airwaydentists.com"
        />
        <TextField
          form={form}
          name="lat"
          label="Latitude"
          placeholder="29.7628686"
        />
        <TextField
          form={form}
          name="lng"
          label="Longitude"
          placeholder="-95.4548186"
        />
        <TextField
          form={form}
          name="radiusMiles"
          label="Radius (miles)"
          placeholder="5"
        />
        <TextField
          form={form}
          name="phone"
          label="Phone"
          placeholder="(312) 555-0100"
        />
        <TextField
          form={form}
          name="street"
          label="Street"
          placeholder="123 N Michigan Ave"
        />
        <TextField
          form={form}
          name="postalCode"
          label="Postal code"
          placeholder="60601"
        />
      </div>

      <TextField
        form={form}
        name="matchTerms"
        label="Match terms"
        placeholder="chicago, the loop, legacy brand name"
        hint="Comma separated. Other names Google might show for this office."
      />

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={props.onDone}
        >
          Cancel
        </button>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {props.location ? "Save location" : "Add location"}
            </button>
          )}
        </form.Subscribe>
      </div>

      <form.Subscribe selector={(state) => state.errorMap}>
        {(errorMap) => {
          const message = getFormError(errorMap.onSubmit);
          return message ? (
            <div className="alert alert-error py-2">
              <span className="text-sm">{message}</span>
            </div>
          ) : null;
        }}
      </form.Subscribe>
    </form>
  );
}

function TextField({
  form,
  name,
  label,
  placeholder,
  hint,
}: {
  form: LocationForm;
  name: keyof LocationFormValues;
  label: string;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <form.Field name={name}>
      {(field) => {
        const error = getFieldError(field.state.meta.errors);
        return (
          <label className="block space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-base-content/60">
              {label}
            </span>
            <input
              className={`input input-bordered input-sm w-full ${error ? "input-error" : ""}`}
              placeholder={placeholder}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            {error ? <span className="text-xs text-error">{error}</span> : null}
            {!error && hint ? (
              <span className="block text-xs text-base-content/50">{hint}</span>
            ) : null}
          </label>
        );
      }}
    </form.Field>
  );
}
