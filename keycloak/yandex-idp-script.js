/**
 * Available variables:
 * realm - current realm
 * session - KeycloakSession
 * accessToken - OAuth2 access token from Yandex
 */
var SimpleHttp = Java.type('org.keycloak.broker.provider.util.SimpleHttp');
var BrokeredUserProfile = Java.type('io.phasetwo.keycloak.oauth2idp.model.BrokeredUserProfile');

var response = SimpleHttp.doGet("https://login.yandex.ru/info?format=json", session)
  .header("Authorization", "OAuth " + accessToken)
  .asString();

var identity = JSON.parse(response);

var profile = new BrokeredUserProfile();
profile.setUsername(identity.login || identity.id || identity.default_email);
profile.setEmail(identity.default_email || identity.email || "");
profile.setFirstName(identity.first_name || "");
profile.setLastName(identity.last_name || "");
profile.setMappingContext(identity);

profile;
