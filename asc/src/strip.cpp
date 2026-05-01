//
// strip.cpp
//
// Object Strip. Strip is the area between 2 consecutive dikes or ligns.
//
// Tien-Tsin Wong
//
#include <stdlib.h>
#include <stdio.h>
#include "asc.h"
#include "datatype.h"
#include "misc.h"
#include "common.h"
#include "dikelign.h"
#include "strip.h"

///////////////////////////// Class Strip /////////////////////////////////
#define TAGMAP(i,j) tagmap[j*N+i]
void ShowTagMap(Strip *xstrip)
{
#ifdef SECURITY
  if (xstrip==NULL)
  {
    ERRMSG("[ShowTagMap]: invalid input value\n");
    return;
  }
#endif
  CHAR tagmap[N*N];
  int i, j, k;
  for (j=0 ; j<N ; j++)
    for (i=0 ; i<N ; i++)
      TAGMAP(i,j) = FALSE;
  for (j=0 ; j<N ; j++)
    for (k=1 ; k<SIZE ; k++)
      if (xstrip[j].usedby[k] != NULL)
        for (i=Start(k) ; i<End(k) ; i++)
          TAGMAP(i,j) = TRUE;

  for (j=N-1 ; j>=0 ; j--)
  {
    for (i=0 ; i<N ; i++)
      if (TAGMAP(i,j))
        printf ("* ");
      else
        printf (". ");
    printf ("\n");
  }
}


void Strip::Init(Lign *lign1, Lign *lign2)
{
#ifdef SECURITY
  if (lign1==NULL || lign2==NULL)
  {
    ERRMSG("[Strip::Init]: invalid input value\n");
    return;
  }
#endif
  register int i;
  Padi **used = usedby;
  SIMPLEDT *simp = simple,
           *lign1simp = lign1->simple,
           *lign2simp = lign2->simple;
  for (i=0 ; i<SIZE ; i++, simp++, lign1simp++, lign2simp++, used++)
  {
    *used = NULL;
    *simp = MAX(*lign1simp, *lign2simp);
  }
#ifdef DEBUG
  DISPLAYTREE(simple);
#endif
}


// This function test whether the input dike is already occupied by
// any other dikes
//
// INPUT PARAMETERS:
// 1) dike      The dike enquiried
// 2) occup     An array to hold the competitor dike
// 3) cnt       No of element in occup[]
//
// OUTPUT PARAMETERS:
// return COMPLETEUSED if completely occupied
// return PARTIALUSED if partially occupied
// return NOTUSED if nobody occupied
// In any cases that enquiy dike is partially or compeletely occupied by
// other dike, the competitors will be append into the occup[]
int Strip::UsedBy(int dike, Padi **occup, int &cnt)
{
#ifdef SECURITY
  if (dike<1 || dike>SIZE || occup==NULL || cnt<0)
  {
    ERRMSG("[Strip::UsedBy]: invalid input value\n");
    return COMPLETEUSED;
  }
#endif
  int lb, ub, dikelevel, i, j, occlength=0, dikelength;
  // Check occupancy upward the tree
  for (i=dike ; i>0 ; i>>=1);
    if (usedby[i]!=NULL) // the input strip is enclosed by larger strip
    { // assume no overlapping, the caller should make sure this point
      for (j=cnt-1 ; j>=0 ; j--)
        if (occup[j]==usedby[i]) // check whether it already in occup[]
          break;
      if (j<0)
        occup[cnt++] = usedby[i];
      return COMPLETEUSED; // completely used up
    }

  // Check occupancy downward the tree
  dikelevel = Level(dike);
  dikelength = Length(dike);
  occlength = 0;
  lb = ub = dike;
  while(dikelevel<=NLEVEL)
  {
    for (i=lb ; i<=ub ; i++)
      if (usedby[i]!=NULL)
      {
        for (j=cnt-1 ; j>=0 ; j--) // search whether this padi already in the array
          if (occup[j]==usedby[i]) // of course we assume there is very few competitors
            break;                 // otherwise, this search may be time consuming
        if (j<0)  // record it in the array only when it is new competitor
          occup[cnt++] = usedby[i];
        occlength += Length(i); // assume all competitor come to this point are unique
        if (dikelength==occlength)
          return COMPLETEUSED; // completely used up
      }
    dikelevel++;
    lb = lb<<1;
    ub = (ub<<1)+1;
  }
  if (occlength>0)
    return PARTIALUSED;
  else
    return NOTUSED;
}

