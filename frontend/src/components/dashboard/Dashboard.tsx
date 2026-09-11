import { FeedbackButton } from "@/components/feedback/FeedbackButton";
import { captureEvent } from "@/lib/analytics/analytics";
import { authLogic } from "@/lib/logics/authLogic";
import { connectionsLogic } from "@/lib/logics/connectionsLogic";
import { pokeSettingsLogic } from "@/lib/logics/pokeSettingsLogic";
import { slackLogic } from "@/lib/logics/slackLogic";
import { useActions, useValues } from "kea";
import { useEffect } from "react";
import { DashboardPage } from "./DashboardPage";

/** The dashboard on real data. Everything visual lives in DashboardPage. */
export function Dashboard() {
  const { userData, userDataLoading } = useValues(authLogic);
  const { logout } = useActions(authLogic);
  const { connections, installUrl, resultLoading, pendingIds, actionError } =
    useValues(connectionsLogic);
  const { loadConnections, subscribe, unsubscribe, uninstall } =
    useActions(connectionsLogic);
  const {
    connection: slackConnection,
    resultLoading: slackLoading,
    testState,
    actionError: slackError,
  } = useValues(slackLogic);
  const { loadConnection, disconnect, sendTestPoke } = useActions(slackLogic);
  // No load of its own: these ride in on the profile, which authLogic has already read.
  const {
    mutedTypes,
    reviewRequestResolution,
    digestEnabled,
    digestHour,
    notice,
  } = useValues(pokeSettingsLogic);
  const {
    toggleType,
    setReviewRequestResolution,
    setDigestEnabled,
    setDigestHour,
  } = useActions(pokeSettingsLogic);

  useEffect(() => {
    loadConnections();
    loadConnection();
  }, [loadConnections, loadConnection]);

  // Loaded once we have a profile, or once we have stopped trying - a failed fetch must still
  // show Log out.
  const userLoaded = userData !== null || !userDataLoading;

  return (
    <DashboardPage
      className="min-h-dvh"
      user={{
        login: userData?.githubLogin,
        avatarUrl: userData?.avatarUrl,
        loaded: userLoaded,
      }}
      onLogout={logout}
      // The one control on this page that reports itself. Everything else here captures a
      // `frontend_*` event; the popover sends PostHog's own `survey shown`/`sent`/`dismissed`,
      // which is what puts an answer on the survey rather than in a custom event nobody reads.
      feedback={<FeedbackButton />}
      connections={connections}
      installUrl={installUrl}
      loading={resultLoading}
      pendingIds={pendingIds}
      actionError={actionError}
      onSubscribe={subscribe}
      onUnsubscribe={unsubscribe}
      onUninstall={uninstall}
      /*
        The three controls that leave proke for github.com or slack.com. Everything else on this
        page goes through a logic, which is where its event is captured; these have no action to
        hang one off, and they are the last thing seen before a round trip plenty of people
        never come back from - so the click is the only evidence they tried.

        Passed from here rather than written into the panels because those are presentational
        and the drafts gallery renders them on mock data.
      */
      onAddClick={() =>
        captureEvent("org_install_clicked", { already_on: connections.length })
      }
      onManageClick={(installationId) =>
        captureEvent("org_manage_clicked", {
          installation_id: installationId,
          // An owner leaves for the repository picker; anyone else leaves for the install flow,
          // which turns into a request to the owners. Same click, two different journeys, and
          // only the second one has somebody else at the end of it.
          viewer_role: connections.find(
            (connection) => connection.installationId === installationId
          )?.viewerRole,
        })
      }
      pokes={{
        mutedTypes,
        reviewRequestResolution,
        digestEnabled,
        digestHour,
        notice,
        onToggleType: toggleType,
        onSetReviewRequestResolution: setReviewRequestResolution,
        onSetDigestEnabled: setDigestEnabled,
        onSetDigestHour: setDigestHour,
      }}
      slack={{
        connection: slackConnection,
        loading: slackLoading,
        testState,
        actionError: slackError,
        onDisconnect: disconnect,
        onTest: sendTestPoke,
        onConnectClick: () => captureEvent("slack_connect_clicked"),
        onInstallClick: () =>
          captureEvent("slack_install_clicked", {
            team_id: slackConnection.teamId,
          }),
      }}
    />
  );
}
