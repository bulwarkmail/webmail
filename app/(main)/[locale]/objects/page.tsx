import { ProjectsApp } from "@/components/xenaxio/projects/projects-app";

// xenaxio, step 119: records of the company's own object types (contracts, vehicles …).
// One page for every type: /objects?type=<key>&id=<record> (the static Lite export needs no paths per type).
export default function ObjectsRoute() {
  return <ProjectsApp objects />;
}
