import { ProjectsApp } from "@/components/xenaxio/projects/projects-app";

// xenaxio, step 118: projects with boards, next to mail, calendar, chat and flows.
// One page; the project and task are in the query (?id=…&task=…), so the static Lite export needs no paths per project.
export default function ProjectsRoute() {
  return <ProjectsApp />;
}
